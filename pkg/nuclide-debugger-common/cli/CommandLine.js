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

import readline from 'readline';
import CommandDispatcher from './CommandDispatcher';
import type {ConsoleIO} from './ConsoleIO';

export default class CommandLine implements ConsoleIO {
  _dispatcher: CommandDispatcher;
  _cli: readline$Interface;
  _inputStopped = false;
  _shouldPrompt = false;

  constructor(dispatcher: CommandDispatcher) {
    this._dispatcher = dispatcher;
    this._cli = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    this._cli.setPrompt('fbdb> ');
  }

  // $TODO handle
  // (1) async output that happens while the user is typing at the prompt
  // (2) paging long output (more) if termcap allows us to know the screen height
  output(text: string): void {
    process.stdout.write(text);
  }

  outputLine(line?: string = ''): void {
    process.stdout.write(`${line}\n`);
  }

  stopInput(): void {
    this._inputStopped = true;
  }

  startInput(): void {
    this._inputStopped = false;
    if (this._shouldPrompt) {
      this._cli.prompt();
      this._shouldPrompt = false;
    }
  }

  run(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this._inputStopped) {
        this._cli.prompt();
      } else {
        this._shouldPrompt = true;
      }
      this._cli
        .on('line', this._executeCommand.bind(this))
        .on('close', resolve);
    });
  }

  close(): void {
    this._cli.close();
  }

  async _executeCommand(line: string): Promise<void> {
    try {
      await this._dispatcher.execute(line);
    } catch (x) {
      this.outputLine(x.message);
    } finally {
      if (!this._inputStopped) {
        this._cli.prompt();
      } else {
        this._shouldPrompt = true;
      }
    }
  }
}
