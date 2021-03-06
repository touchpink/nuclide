/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow
 * @format
 */

import type {NuclideUri} from 'nuclide-commons/nuclideUri';
import type {ClangRequestSettings} from '../../nuclide-clang-rpc/lib/rpc-types';
import type {HostServices} from '../../nuclide-language-service-rpc/lib/rpc-types';

import fs from 'nuclide-commons/fsPromise';
import os from 'os';
import nuclideUri from 'nuclide-commons/nuclideUri';
import {Observable} from 'rxjs';
import {
  MultiProjectLanguageService,
  forkHostServices,
} from '../../nuclide-language-service-rpc';
import {FileCache} from '../../nuclide-open-files-rpc';
import {Cache} from 'nuclide-commons/cache';
import UniversalDisposable from 'nuclide-commons/UniversalDisposable';
import {LspLanguageService} from '../../nuclide-vscode-language-service-rpc/lib/LspLanguageService';

const COMPILATION_DATABASE_FILE = 'compile_commands.json';

type ManagedRoot = {
  files: Set<string>,
  watchFile: string,
  rootDir: string,
  tempCommandsDir: ?string,
};

function disposeManagedRoot(managedRoot: ?ManagedRoot): void {
  if (!managedRoot) {
    return;
  }
  const {tempCommandsDir} = managedRoot;
  if (tempCommandsDir != null) {
    fs.rimraf(tempCommandsDir);
  }
}

export default class ClangdLanguageServer extends MultiProjectLanguageService<
  LspLanguageService,
> {
  // Maps clang settings => settings metadata with same key as _processes field.
  _managedRoots: Map<string, Promise<ManagedRoot>>;
  constructor(
    languageId: string,
    command: string,
    logger: log4js$Logger,
    fileCache: FileCache,
    host: HostServices,
  ) {
    super();

    this._resources = new UniversalDisposable();

    const server = this; // Access class scope within closure.
    async function clangdServiceFactory(
      compileCommandsPath: string,
    ): Promise<?LspLanguageService> {
      const managedRoot = await server._managedRoots.get(compileCommandsPath);
      // Only proceed if we added the compile commands via addClangRequest
      if (!managedRoot) {
        return null;
      }
      const {rootDir, tempCommandsDir} = managedRoot;
      const args = [
        '-enable-snippets',
        // TODO pelmers For debugging:
        // '-debug',
        // '-input-mirror-file',
        // '/Users/pelmers/clangd.log',
        // '-run-synchronously',
      ];
      if (tempCommandsDir != null) {
        args.push('-compile-commands-dir', tempCommandsDir);
      }
      await server.hasObservedDiagnostics();
      const lsp = new LspLanguageService(
        logger,
        fileCache,
        await forkHostServices(host, logger),
        languageId,
        command,
        args,
        {}, // spawnOptions
        rootDir,
        ['.cpp', '.h', '.hpp'],
        {},
        5 * 60 * 1000, // 5 minutes
      );

      lsp.start(); // Kick off 'Initializing'...
      return lsp;
    }

    this._processes = new Cache(clangdServiceFactory, value => {
      value.then(service => {
        if (service != null) {
          service.dispose();
        }
      });
    });

    this._managedRoots = new Map();

    this._resources.add(host, this._processes);

    this._resources.add(
      () => {
        this._closeProcesses();
      },
      () => {
        // Delete temporary directories.
        for (const managedRoot of this._managedRoots.values()) {
          managedRoot.then(disposeManagedRoot);
        }
      },
    );
    // Remove fileCache when the remote connection shuts down
    this._resources.add(
      fileCache
        .observeFileEvents()
        .filter(event => event.kind === 'save')
        .switchMap(({fileVersion: {filePath}}) =>
          Observable.fromPromise(
            Promise.all(
              Array.from(
                this._managedRoots.entries(),
              ).map(([key, valPromise]) =>
                valPromise.then(value => ({key, value})),
              ),
            ).then(entries =>
              // Keep only the roots that are watching the saved file.
              entries
                .filter(({value}) => value.watchFile === filePath)
                .map(({key}) => key),
            ),
          ),
        )
        .subscribe(
          keys => {
            for (const key of keys) {
              this._logger.info('Watch file saved, invalidating ' + key);
              this._processes.delete(key);
              this._managedRoots.delete(key);
              const managedRoot = this._managedRoots.get(key);
              if (managedRoot) {
                managedRoot.then(disposeManagedRoot);
              }
            }
          },
          undefined, // error
          () => {
            this._logger.info('fileCache shutting down.');
            this._closeProcesses();
          },
        ),
    );
  }

  async _setupManagedRoot(
    file: string,
    flagsFile: string,
  ): Promise<ManagedRoot> {
    const rootDir = nuclideUri.dirname(flagsFile);
    // See https://clang.llvm.org/docs/JSONCompilationDatabase.html for spec
    // Add the files of this database to the managed map.
    const contents = await fs.readFile(file);
    // Create a temporary directory with only compile_commands.json because
    // clangd requires the name of a directory containing a
    // compile_commands.json, which is not always what we are provided here.
    const tmpDir = nuclideUri.join(
      os.tmpdir(),
      'nuclide-clangd-lsp-' + Math.random().toString(),
    );
    if (!await fs.mkdirp(tmpDir)) {
      throw new Error(`Failed to create temporary directory at ${tmpDir}`);
    }
    const tmpCommandsPath = nuclideUri.join(tmpDir, COMPILATION_DATABASE_FILE);
    await fs.writeFile(tmpCommandsPath, contents);
    this._logger.info(
      'Copied commands from ' + file + ' to ' + tmpCommandsPath,
    );
    // Trigger the factory to construct the server.
    this._processes.get(file);
    return {
      rootDir,
      watchFile: flagsFile,
      files: new Set(JSON.parse(contents.toString()).map(entry => entry.file)),
      tempCommandsDir: tmpDir,
    };
  }

  async addClangRequest(clangRequest: ClangRequestSettings): Promise<boolean> {
    // Start new server for compile commands path and add to managed list.
    // Return whether successful.
    const database = clangRequest.compilationDatabase;
    if (!database) {
      return false;
    }
    // file = compile commands, flags file = build target
    const {file, flagsFile} = database;
    if (file == null || flagsFile == null) {
      return false;
    }
    if (!this._managedRoots.has(file)) {
      this._managedRoots.set(file, this._setupManagedRoot(file, flagsFile));
    }
    return true;
  }

  async isFileKnown(filePath: NuclideUri): Promise<boolean> {
    // TODO pelmers: header files are always false here, but we could borrow
    // ClangFlagsManager._findSourceFileForHeaderFromCompilationDatabase
    return this.getClangRequestSettingsForFile(filePath) != null;
  }

  async getClangRequestSettingsForFile(filePath: NuclideUri): Promise<?string> {
    const absPath = nuclideUri.getPath(filePath);
    this._logger.info('checking for ' + absPath);
    const resolvedRoots = await Promise.all(
      Array.from(this._managedRoots.entries()).map(([k, vPromise]) =>
        vPromise.then(v => [k, v]),
      ),
    );
    for (const [commandsPath, managedRoot] of resolvedRoots) {
      if (managedRoot.files.has(absPath)) {
        return commandsPath;
      }
    }
    // Search up through file tree for manually provided compile_commands.json
    // Similar to ClangFlagsManager._getDBFlagsAndDirForSrc
    const dbDir = await fs.findNearestFile(
      COMPILATION_DATABASE_FILE,
      nuclideUri.dirname(filePath),
    );
    if (dbDir != null) {
      const dbFile = nuclideUri.join(dbDir, COMPILATION_DATABASE_FILE);
      const compilationDatabase = {
        file: dbFile,
        flagsFile: dbFile,
        libclangPath: null,
      };
      if (
        await this.addClangRequest({projectRoot: dbDir, compilationDatabase})
      ) {
        return dbFile;
      }
    }

    return null;
  }

  async getLanguageServiceForFile(
    filePath: NuclideUri,
  ): Promise<?LspLanguageService> {
    const commandsPath = await this.getClangRequestSettingsForFile(filePath);
    if (commandsPath != null) {
      this._logger.info('Found existing service for ' + filePath);
      this._logger.info('Key: ' + commandsPath);
      const result = this._processes.get(commandsPath);
      if (result == null) {
        // Delete so we retry next time.
        this._processes.delete(commandsPath);
      }
      return result;
    }
    this._logger.info(
      ' if path is reasonable then i should have created server for it already?',
    );
    return null;
  }
}
