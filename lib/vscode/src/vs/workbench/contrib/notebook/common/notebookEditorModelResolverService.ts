/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator, IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { URI } from 'vs/base/common/uri';
import { CellUri, IResolvedNotebookEditorModel } from 'vs/workbench/contrib/notebook/common/notebookCommon';
import { ComplexNotebookEditorModel, NotebookFileWorkingCopyModel, NotebookFileWorkingCopyModelFactory, SimpleNotebookEditorModel } from 'vs/workbench/contrib/notebook/common/notebookEditorModel';
import { combinedDisposable, DisposableStore, IDisposable, IReference, ReferenceCollection } from 'vs/base/common/lifecycle';
import { ComplexNotebookProviderInfo, INotebookService, SimpleNotebookProviderInfo } from 'vs/workbench/contrib/notebook/common/notebookService';
import { ILogService } from 'vs/platform/log/common/log';
import { Emitter, Event } from 'vs/base/common/event';
import { FileWorkingCopyManager, IFileWorkingCopyManager } from 'vs/workbench/services/workingCopy/common/fileWorkingCopyManager';
import { IResolvedFileWorkingCopy } from 'vs/workbench/services/workingCopy/common/fileWorkingCopy';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';

export const INotebookEditorModelResolverService = createDecorator<INotebookEditorModelResolverService>('INotebookModelResolverService');

export interface INotebookEditorModelResolverService {
	readonly _serviceBrand: undefined;

	onDidSaveNotebook: Event<URI>;

	resolve(resource: URI, viewType?: string): Promise<IReference<IResolvedNotebookEditorModel>>;
}

class NotebookModelReferenceCollection extends ReferenceCollection<Promise<IResolvedNotebookEditorModel>> {

	private readonly _workingCopyManager: IFileWorkingCopyManager<NotebookFileWorkingCopyModel>;
	private readonly _modelListener = new Map<IResolvedNotebookEditorModel, IDisposable>();

	private readonly _onDidSaveNotebook = new Emitter<URI>();
	readonly onDidSaveNotebook: Event<URI> = this._onDidSaveNotebook.event;

	constructor(
		@IInstantiationService readonly _instantiationService: IInstantiationService,
		@INotebookService private readonly _notebookService: INotebookService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._workingCopyManager = <any>_instantiationService.createInstance(
			FileWorkingCopyManager,
			new NotebookFileWorkingCopyModelFactory(_notebookService)
		);
	}

	protected async createReferencedObject(key: string, viewType: string): Promise<IResolvedNotebookEditorModel> {
		const uri = URI.parse(key);
		const info = await this._notebookService.withNotebookDataProvider(uri, viewType);

		let result: IResolvedNotebookEditorModel;

		if (info instanceof ComplexNotebookProviderInfo) {
			const model = this._instantiationService.createInstance(ComplexNotebookEditorModel, uri, viewType, info.controller);
			result = await model.load();

		} else if (info instanceof SimpleNotebookProviderInfo) {
			const workingCopy = await this._workingCopyManager.resolve(uri);
			result = new SimpleNotebookEditorModel(<IResolvedFileWorkingCopy<NotebookFileWorkingCopyModel>>workingCopy);

		} else {
			throw new Error(`CANNOT open ${key}, no provider found`);
		}

		this._modelListener.set(result, result.onDidSave(() => this._onDidSaveNotebook.fire(result.resource)));
		return result;
	}

	protected destroyReferencedObject(_key: string, object: Promise<IResolvedNotebookEditorModel>): void {
		object.then(model => {
			this._modelListener.get(model)?.dispose();
			this._modelListener.delete(model);
			model.dispose();
		}).catch(err => {
			this._logService.critical('FAILED to destory notebook', err);
		});
	}
}

export class NotebookModelResolverService implements INotebookEditorModelResolverService {

	readonly _serviceBrand: undefined;

	private readonly _data: NotebookModelReferenceCollection;

	readonly onDidSaveNotebook: Event<URI>;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@INotebookService private readonly _notebookService: INotebookService,
		@IExtensionService private readonly _extensionService: IExtensionService,
	) {
		this._data = instantiationService.createInstance(NotebookModelReferenceCollection);
		this.onDidSaveNotebook = this._data.onDidSaveNotebook;
	}

	async resolve(resource: URI, viewType?: string): Promise<IReference<IResolvedNotebookEditorModel>> {
		if (resource.scheme === CellUri.scheme) {
			throw new Error(`CANNOT open a cell-uri as notebook. Tried with ${resource.toString()}`);
		}

		const existingViewType = this._notebookService.getNotebookTextModel(resource)?.viewType;
		if (!viewType) {
			if (existingViewType) {
				viewType = existingViewType;
			} else {
				await this._extensionService.whenInstalledExtensionsRegistered();
				const providers = this._notebookService.getContributedNotebookProviders(resource);
				const exclusiveProvider = providers.find(provider => provider.exclusive);
				viewType = exclusiveProvider?.id || providers[0]?.id;
			}
		}

		if (!viewType) {
			throw new Error(`Missing viewType for '${resource}'`);
		}

		if (existingViewType && existingViewType !== viewType) {
			throw new Error(`A notebook with view type '${existingViewType}' already exists for '${resource}', CANNOT create another notebook with view type ${viewType}`);
		}

		const reference = this._data.acquire(resource.toString(), viewType);
		const model = await reference.object;
		const autoRef = NotebookModelResolverService._autoReferenceDirtyModel(model, () => this._data.acquire(resource.toString(), viewType));
		return {
			object: model,
			dispose() {
				reference.dispose();
				autoRef.dispose();
			}
		};
	}

	private static _autoReferenceDirtyModel(model: IResolvedNotebookEditorModel, ref: () => IDisposable): IDisposable {

		const references = new DisposableStore();
		const listener = model.onDidChangeDirty(() => {
			if (model.isDirty()) {
				references.add(ref());
			} else {
				references.clear();
			}
		});

		const onceListener = Event.once(model.notebook.onWillDispose)(() => {
			listener.dispose();
			references.dispose();
		});

		return combinedDisposable(references, listener, onceListener);
	}
}
