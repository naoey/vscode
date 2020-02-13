/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ExtHostNotebookShape, IMainContext, MainThreadNotebookShape, MainContext, MainThreadDocumentsShape } from 'vs/workbench/api/common/extHost.protocol';
import { IExtensionDescription } from 'vs/platform/extensions/common/extensions';
import { Disposable as VSCodeDisposable } from './extHostTypes';
import { URI } from 'vs/base/common/uri';
import { DisposableStore } from 'vs/base/common/lifecycle';
import { readonly } from 'vs/base/common/errors';
import { Emitter, Event } from 'vs/base/common/event';
import { ExtHostDocumentsAndEditors } from 'vs/workbench/api/common/extHostDocumentsAndEditors';
import { ICell } from 'vs/editor/common/modes';
// import { ExtHostDocumentData } from 'vs/workbench/api/common/extHostDocumentData';
import * as extHostTypeConverter from 'vs/workbench/api/common/extHostTypeConverters';
import { IMarkdownString } from 'vs/base/common/htmlContent';

export class ExtHostCell implements vscode.NotebookCell {

	private static _handlePool: number = 0;
	readonly handle = ExtHostCell._handlePool++;
	public source: string[];
	private _outputs: any[];
	private _onDidChangeOutputs = new Emitter<void>();
	onDidChangeOutputs: Event<void> = this._onDidChangeOutputs.event;
	private _textDocument: vscode.TextDocument | undefined;
	private _initalVersion: number = -1;

	constructor(
		private _content: string,
		public cell_type: 'markdown' | 'code',
		public language: string,
		outputs: any[]
	) {
		this.source = this._content.split(/\r|\n|\r\n/g);
		this._outputs = outputs;
	}

	get outputs() {
		return this._outputs;
	}

	set outputs(newOutputs: any[]) {
		this._outputs = newOutputs;
		this._onDidChangeOutputs.fire();
	}

	getContent(): string {
		if (this._textDocument && this._initalVersion !== this._textDocument?.version) {
			return this._textDocument.getText();
		} else {
			return this.source.join('\n');
		}
	}

	attachTextDocument(document: vscode.TextDocument) {
		this._textDocument = document;
		this._initalVersion = this._textDocument.version;
	}

	detachTextDocument(document: vscode.TextDocument) {
		if (this._textDocument && this._textDocument.version !== this._initalVersion) {
			this.source = this._textDocument.getText().split(/\r|\n|\r\n/g);
		}

		this._textDocument = undefined;
		this._initalVersion = -1;
	}
}

export class ExtHostNotebookDocument implements vscode.NotebookDocument {
	private static _handlePool: number = 0;
	readonly handle = ExtHostNotebookDocument._handlePool++;

	private _cells: ExtHostCell[] = [];

	private _cellDisposableMapping = new Map<number, DisposableStore>();

	get cells() {
		return this._cells;
	}

	set cells(newCells: ExtHostCell[]) {
		this._cells = newCells;
		this._cells.forEach(cell => {
			if (!this._cellDisposableMapping.has(cell.handle)) {
				this._cellDisposableMapping.set(cell.handle, new DisposableStore());
			}

			let store = this._cellDisposableMapping.get(cell.handle)!;
			store.add(cell.onDidChangeOutputs(() => {
				let outputs = cell.outputs;
				if (outputs && outputs.length) {
					outputs = outputs.map(output => {
						let handler = this.renderingHandler.findBestMatchedRenderer(output);

						if (handler) {
							return handler.render(this, cell, output);
						} else {
							return output;
						}
					})
				}

				this._proxy.$updateNotebookCell(this.viewType, this.uri, {
					handle: cell.handle,
					source: cell.source,
					language: cell.language,
					cell_type: cell.cell_type,
					outputs: outputs,
					isDirty: false
				});
			}));
		});
	}

	private _languages: string[] = [];

	get languages() {
		return this._languages = [];
	}

	set languages(newLanguages: string[]) {
		this._languages = newLanguages;
		this._proxy.$updateNotebookLanguages(this.viewType, this.uri, this._languages);
	}

	constructor(
		private readonly _proxy: MainThreadNotebookShape,
		public viewType: string,
		public uri: URI,
		public renderingHandler: ExtHostNotebookOutputRenderingHandler
	) {

	}

	get fileName() { return this.uri.fsPath; }

	get isDirty() { return false; }

	async $updateCells(): Promise<void> {
		return await this._proxy.$updateNotebookCells(this.viewType, this.uri, this.cells.map(cell => {
			let outputs = cell.outputs;
			if (outputs && outputs.length) {
				outputs = outputs.map(output => {
					let handler = this.renderingHandler.findBestMatchedRenderer(output);

					if (handler) {
						return handler.render(this, cell, output);
					} else {
						return output;
					}
				})
			}

			return {
				handle: cell.handle,
				source: cell.source,
				language: cell.language,
				cell_type: cell.cell_type,
				outputs: outputs,
				isDirty: false
			}
		}
	));
	}

	insertRawCell(index: number, cell: ExtHostCell) {
		this.cells.splice(index, 0, cell);

		if (!this._cellDisposableMapping.has(cell.handle)) {
			this._cellDisposableMapping.set(cell.handle, new DisposableStore());
		}

		let store = this._cellDisposableMapping.get(cell.handle)!;

		store.add(cell.onDidChangeOutputs(() => {
			let outputs = cell.outputs;
			if (outputs && outputs.length) {
				outputs = outputs.map(output => {
					let handler = this.renderingHandler.findBestMatchedRenderer(output);

					if (handler) {
						return handler.render(this, cell, output);
					} else {
						return output;
					}
				})
			}

			this._proxy.$updateNotebookCell(this.viewType, this.uri, {
				handle: cell.handle,
				source: cell.source,
				language: cell.language,
				cell_type: cell.cell_type,
				outputs: outputs,
				isDirty: false
			});
		}));
	}

	deleteCell(index: number): boolean {
		if (index >= this.cells.length) {
			return false;
		}

		let cell = this.cells[index];
		this._cellDisposableMapping.get(cell.handle)?.dispose();
		this._cellDisposableMapping.delete(cell.handle);

		this.cells.splice(index, 1);
		return true;
	}

	getActiveCell(cellHandle: number) {
		return this.cells.find(cell => cell.handle === cellHandle);
	}

	attachCellTextDocument(cellHandle: number, textDocument: vscode.TextDocument) {
		let cell = this.cells.find(cell => cell.handle === cellHandle);

		if (cell) {
			cell.attachTextDocument(textDocument);
		}
	}

	detachCellTextDocument(cellHandle: number, textDocument: vscode.TextDocument) {
		let cell = this.cells.find(cell => cell.handle === cellHandle);

		if (cell) {
			cell.detachTextDocument(textDocument);
		}
	}
}

export class ExtHostNotebookEditor implements vscode.NotebookEditor {
	private _viewColumn: vscode.ViewColumn | undefined;

	constructor(
		private viewType: string,
		private readonly _proxy: MainThreadNotebookShape,
		readonly id: string,
		public uri: URI,
		public document: ExtHostNotebookDocument,
		private readonly documentsProxy: MainThreadDocumentsShape,
		private _documentsAndEditors: ExtHostDocumentsAndEditors
	) {
		let regex = new RegExp(`notebook\\+${viewType}-(\\d+)-(\\d+)`);
		this._documentsAndEditors.onDidAddDocuments(documents => {
			for (const data of documents) {
				let textDocument = data.document;
				let authority = textDocument.uri.authority;

				if (authority !== '') {
					let matches = regex.exec(authority);
					if (matches) {
						const notebookHandle = matches[1];
						const cellHandle = matches[2];

						if (Number(notebookHandle) === this.document.handle) {
							document.attachCellTextDocument(Number(cellHandle), textDocument);
						}
					}
				}
			}
		});

		this._documentsAndEditors.onDidRemoveDocuments(documents => {
			for (const data of documents) {
				let textDocument = data.document;
				let authority = textDocument.uri.authority;

				if (authority !== '') {
					let matches = regex.exec(authority);
					if (matches) {
						const notebookHandle = matches[1];
						const cellHandle = matches[2];

						if (Number(notebookHandle) === this.document.handle) {
							document.detachCellTextDocument(Number(cellHandle), textDocument);
						}
					}
				}
			}
		});
	}

	createCell(content: string, language: string, type: 'markdown' | 'code', outputs: vscode.CellOutput[]): vscode.NotebookCell {
		let cell = new ExtHostCell(content, type, language, outputs);
		return cell;
	}

	get viewColumn(): vscode.ViewColumn | undefined {
		return this._viewColumn;
	}

	set viewColumn(value) {
		throw readonly('viewColumn');
	}
}

export class ExtHostNotebookOutputRenderer {
	constructor(
		private filter: vscode.NotebookOutputSelector,
		private renderer: vscode.NotebookOutputRenderer
	) {

	}

	matches(output: vscode.CellOutput): boolean {
		if (output.output_type === this.filter.type) {
			if (output.output_type === 'stream' || output.output_type === 'error') {
				return true;
			}

			if (this.filter.subTypes) {
				for (let i = 0; i < this.filter.subTypes.length; i++) {
					if (output.data[this.filter.subTypes[i]] !== undefined) {
						return true;
					}
				}

				return false;
			} else {
				return true;
			}
		}

		return false;
	}

	render(document: ExtHostNotebookDocument, cell: ExtHostCell, output: vscode.CellOutput): vscode.CellDisplayOutput {
		let html = this.renderer.render(document ,cell, output);

		return {
			output_type: 'display_data',
			data: {
				'text/html': [
					html
				]
			}
		};
	}
}

export interface ExtHostNotebookOutputRenderingHandler {
	findBestMatchedRenderer(output: vscode.CellOutput): ExtHostNotebookOutputRenderer | undefined;
}

export class ExtHostNotebookController implements ExtHostNotebookShape, ExtHostNotebookOutputRenderingHandler {
	private static _handlePool: number = 0;

	private readonly _proxy: MainThreadNotebookShape;
	private readonly _documentsProxy: MainThreadDocumentsShape;
	private readonly _notebookProviders = new Map<string, { readonly provider: vscode.NotebookProvider, readonly extension: IExtensionDescription }>();
	private readonly _documents = new Map<string, ExtHostNotebookDocument>();
	private readonly _editors = new Map<string, ExtHostNotebookEditor>();
	private readonly _notebookOutputRenderers: ExtHostNotebookOutputRenderer[] = [];


	constructor(mainContext: IMainContext, private _documentsAndEditors: ExtHostDocumentsAndEditors) {
		this._proxy = mainContext.getProxy(MainContext.MainThreadNotebook);
		this._documentsProxy = mainContext.getProxy(MainContext.MainThreadDocuments);

	}

	private _activeNotebookDocument: ExtHostNotebookDocument | undefined;

	get activeNotebookDocument() {
		return this._activeNotebookDocument;
	}

	public registerNotebookOutputRenderer(
		extension: IExtensionDescription,
		filter: vscode.NotebookOutputSelector,
		renderer: vscode.NotebookOutputRenderer
	): vscode.Disposable {
		this._notebookOutputRenderers.push(new ExtHostNotebookOutputRenderer(filter, renderer));
		return new VSCodeDisposable(() => {
			
		})
	}

	findBestMatchedRenderer(output: vscode.CellOutput): ExtHostNotebookOutputRenderer | undefined {
		for (let i = 0; i < this._notebookOutputRenderers.length; i++) {
			if (this._notebookOutputRenderers[i].matches(output)) {
				return this._notebookOutputRenderers[i];
			}
		}

		return;
	}

	public registerNotebookProvider(
		extension: IExtensionDescription,
		viewType: string,
		provider: vscode.NotebookProvider,
	): vscode.Disposable {

		if (this._notebookProviders.has(viewType)) {
			throw new Error(`Notebook provider for '${viewType}' already registered`);
		}

		this._notebookProviders.set(viewType, { extension, provider });
		this._proxy.$registerNotebookProvider({ id: extension.identifier, location: extension.extensionLocation }, viewType);
		return new VSCodeDisposable(() => {
			this._notebookProviders.delete(viewType);
			this._proxy.$unregisterNotebookProvider(viewType);
		});
	}

	async $resolveNotebook(viewType: string, uri: URI): Promise<number | undefined> {
		let provider = this._notebookProviders.get(viewType);

		if (provider) {
			if (!this._documents.has(URI.revive(uri).toString())) {
				let document = new ExtHostNotebookDocument(this._proxy, viewType, URI.revive(uri), this);
				await this._proxy.$createNotebookDocument(
					document.handle,
					viewType,
					uri
				);

				this._documents.set(URI.revive(uri).toString(), document);
			}

			let editor = new ExtHostNotebookEditor(
				viewType,
				this._proxy,
				`${ExtHostNotebookController._handlePool++}`,
				uri,
				this._documents.get(URI.revive(uri).toString())!,
				this._documentsProxy,
				this._documentsAndEditors
			);

			this._editors.set(URI.revive(uri).toString(), editor);
			await provider.provider.resolveNotebook(editor);
			await editor.document.$updateCells();
			return editor.document.handle;
		}

		return Promise.resolve(undefined);
	}

	async $executeNotebook(viewType: string, uri: URI): Promise<void> {
		let provider = this._notebookProviders.get(viewType);

		if (provider) {
			let document = this._documents.get(URI.revive(uri).toString());

			return provider.provider.executeCell(document!, undefined);
		}
	}

	async $executeNotebookCell(viewType: string, uri: URI, cellHandle: number): Promise<void> {
		let provider = this._notebookProviders.get(viewType);

		if (provider) {
			let document = this._documents.get(URI.revive(uri).toString());
			let cell = document?.getActiveCell(cellHandle);

			if (cell) {
				return provider.provider.executeCell(document!, cell!);
			}
		}
	}

	async $latexRenderer(viewType: string, value: string): Promise<IMarkdownString | undefined> {
		let provider = this._notebookProviders.get(viewType);

		if (provider && provider.provider.latexRenderer) {
			let res = await provider.provider.latexRenderer(value);
			return extHostTypeConverter.MarkdownString.from(res);
		}

		return;
	}

	async $createRawCell(viewType: string, uri: URI, index: number, language: string, type: 'markdown' | 'code'): Promise<ICell | undefined> {
		let provider = this._notebookProviders.get(viewType);

		if (provider) {
			let editor = this._editors.get(URI.revive(uri).toString());
			let document = this._documents.get(URI.revive(uri).toString());

			let rawCell = editor?.createCell('', language, type, []) as ExtHostCell;
			document?.insertRawCell(index, rawCell!);
			return {
				handle: rawCell.handle,
				source: rawCell.source,
				language: rawCell.language,
				cell_type: rawCell.cell_type,
				outputs: rawCell.outputs,
				isDirty: false
			};
		}

		return;
	}

	async $deleteCell(viewType: string, uri: URI, index: number): Promise<boolean> {
		let provider = this._notebookProviders.get(viewType);

		if (provider) {
			let document = this._documents.get(URI.revive(uri).toString());

			if (document) {
				return document.deleteCell(index);
			}

			return false;
		}

		return false;
	}

	async $saveNotebook(viewType: string, uri: URI): Promise<boolean> {
		let provider = this._notebookProviders.get(viewType);
		let document = this._documents.get(URI.revive(uri).toString());

		if (provider && document) {
			return await provider.provider.save(document);
		}

		return false;
	}

	async $updateActiveEditor(viewType: string, uri: URI): Promise<void> {
		let document = this._documents.get(URI.revive(uri).toString());

		if (document) {
			this._activeNotebookDocument = document;
		} else {
			this._activeNotebookDocument = undefined;
		}
	}

	async $destoryNotebookDocument(viewType: string, uri: URI): Promise<boolean> {
		let provider = this._notebookProviders.get(viewType);

		if (provider) {
			let document = this._documents.get(URI.revive(uri).toString());

			if (document) {
				this._documents.delete(URI.revive(uri).toString());
			}

			let editor = this._editors.get(URI.revive(uri).toString());

			if (editor) {
				this._editors.delete(URI.revive(uri).toString());
			}

			return true;
		}

		return false;
	}

}