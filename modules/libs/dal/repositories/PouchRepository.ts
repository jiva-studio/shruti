import { Database } from '../persistence'
import type { FindOneRequest, GetAllRequest, GetManyRequest, GetCountRequest, IRepository, Identifiable, ItemChangedEvent, ItemChangedEventHandler, UnsubscribeFn } from './IRepository'


export abstract class PouchRepository<
  TItem extends Identifiable,
  TDbScheme extends Identifiable,
> implements IRepository<TItem, TDbScheme> {
  protected _database: Database
  private _changeEventHandlers: ItemChangedEventHandler<TItem>[] = []
  private _deserializer: (document: TDbScheme) => TItem
  private _serializer: (item: TItem) => TDbScheme
  private _scope: object = {}

  /**
   * Constructs a new instance of the DatabaseService class.
   * @param database The database instance to be used for data operations.
   * @param serializer A function to serialize the item into the database schema.
   * @param deserializer A function to deserialize the database schema into the item.
   * @param scope An optional scope object to filter the items in the database.
   */
  constructor(
    database: Database,
    serializer: (item: TItem) => TDbScheme,
    deserializer: (document: TDbScheme) => TItem,
    scope: object = {},
  ) {
    this._database = database
    this._serializer = serializer
    this._deserializer = deserializer
    this._scope = scope
  }

  /* -------------------------------------------------------------------------- */
  /*                                Notifications                               */
  /* -------------------------------------------------------------------------- */

  /**
   * Subscribes to item change events.
   * @param handler The event handler function to be called when an item changes.
   * @returns A function to unsubscribe from the events.
   */
  public subscribe(
    handler: ItemChangedEventHandler<TItem>
  ): UnsubscribeFn {
    this._changeEventHandlers.push(handler)
    return () => {
      const index = this._changeEventHandlers.indexOf(handler)
      if (index > -1) {
        this._changeEventHandlers.splice(index, 1)
      }
    }
  }

  /**
   * Notifies all subscribers of a change event.
   * Handlers are executed in parallel and errors are caught to prevent one handler from blocking others.
   * @param event The event to be broadcasted to all subscribers.
   */
  private async notifyChange(
    event: ItemChangedEvent<TItem>
  ) {
    await Promise.allSettled(
      this._changeEventHandlers.map(handler =>
        handler(event).catch(error => {
          console.error('[LCT] [DAL] Error in change event handler:', error)
        })
      )
    )
  }

  /* -------------------------------------------------------------------------- */
  /*                                 DB Methods                                 */
  /* -------------------------------------------------------------------------- */

  /**
   * Retrieves a single item from the database based on the provided Id.
   * @param id The Id of the item to retrieve.
   * @returns A Promise that resolves to the retrieved item.
   * @throws Error if the item with the provided Id is not found in the database.
   */
  async getOne(
    id: string
  ): Promise<TItem> {
    console.debug(`[LCT] [DAL] db.${this._database.db.name}.getOne(${id})`)

    const response = await this._database.db.find({
      selector: { _id: id, ...this._scope },
      limit: 1
    })
    if (!response.docs || response.docs.length === 0) {
      throw new Error(`Document with Id ${id} on database ${this._database.db.name} not found`)
    }
    return this._deserializer(response.docs[0] as unknown as TDbScheme)
  }

  /**
   * Finds a single item in the database based on the provided request.
   * @param request The request object containing the search criteria.
   * @returns A Promise that resolves to the found item, or undefined if not found.
   */
  async findOne(
    request: FindOneRequest<TDbScheme>
  ): Promise<TItem | undefined> {
    console.debug(`[LCT] [DAL] db.${this._database.db.name}.findOne(${JSON.stringify(request)})`)

    const response = await this._database.db.find({
      selector: { ...request, ...this._scope },
      limit: 1
    })
    if (!response.docs || response.docs.length === 0) {
      return undefined
    }
    return this._deserializer(response.docs[0] as unknown as TDbScheme)
  }


  /**
   * Retrieves all items from the database.
   * @param request - Optional request parameters.
   * @returns A promise that resolves to an array of items.
   */
  async getAll(
    request?: GetAllRequest
  ): Promise<TItem[]> {
    const r = {
      selector: {
        ...this._scope,
      },
      limit: request?.limit ?? 25,
      skip: request?.skip ?? 0,
      sort: request?.sort ?? undefined
    }

    console.debug(`[LCT] [DAL] db.${this._database.db.name}.getAll(${JSON.stringify(r)})`)
    const response = await this._database.db.find(r)
    if (response.warning) {
      console.warn(response.warning, JSON.stringify(r))
    }
    return response.docs.map(row => this._deserializer(row as unknown as TDbScheme))
  }

  async getMany(
    request: GetManyRequest<TDbScheme>
  ): Promise<TItem[]> {
    console.debug(`[LCT] [DAL] db.${this._database.db.name}.getMany(${JSON.stringify(request)})`)

    const r = {
      selector: {
        ...this._scope,
        ...request.selector
      },
      limit: request.limit ?? 25,
      skip: request.skip ?? 0,
      sort: request.sort ?? undefined,
      fields: request.fields
    }
    const response = await this._database.db.find(r)
    if (response.warning) {
      console.warn(response.warning, JSON.stringify(r))
    }

    return response.docs
      .map(doc => this._deserializer(doc as unknown as TDbScheme))
  }

  async getIds(
    request: GetManyRequest<TDbScheme>
  ): Promise<string[]> {
    console.debug(`[LCT] [DAL] db.${this._database.db.name}.getIds(${JSON.stringify(request)})`)

    const r = {
      selector: {
        ...this._scope,
        ...request.selector
      },
      limit: request.limit ?? 25,
      skip: request.skip ?? 0,
      sort: request.sort ?? undefined,
      fields: ['_id']
    }
    const response = await this._database.db.find(r)
    if (response.warning) {
      console.warn(response.warning, JSON.stringify(r))
    }
    return response.docs.map(doc => doc._id)
  }

  /**
   * Retrieves the count of items in the database, optionally filtered by selector.
   * Note: When a selector is provided, this method fetches and counts documents,
   * which may be slow for large datasets. For accurate scoped counts without a selector,
   * it performs a query with scope.
   * @param request Optional filter criteria.
   * @returns A promise that resolves to the count of items in the database.
   */
  async getCount(request?: GetCountRequest<TDbScheme>): Promise<number> {
    console.debug(`[LCT] [DAL] db.${this._database.db.name}.getCount(${JSON.stringify(request ?? {})})`)

    const hasScope = Object.keys(this._scope).length > 0
    const hasSelector = request?.selector && Object.keys(request.selector).length > 0

    // Only use db.info() if there's no scope and no selector
    if (!hasScope && !hasSelector) {
      const info = await this._database.db.info()
      return info.doc_count
    }

    // For scoped or filtered queries, we need to fetch and count
    // Note: This could be optimized with a view or by using limit/skip approach
    const response = await this._database.db.find({
      selector: {
        ...this._scope,
        ...(request?.selector ?? {})
      },
      fields: ['_id'],
      limit: 999999 // PouchDB default is much lower, we need to fetch all for accurate count
    })

    return response.docs.length
  }

  /**
   * Adds an item to the database with the specified Id.
   * @param item The item to be added.
   * @returns A promise that resolves when the item is successfully added.
   * @throws Error if the operation fails.
   */
  async addOne(
    item: TItem
  ): Promise<void> {
    console.debug(`[LCT] [DAL] db.${this._database.db.name}.addOne(${JSON.stringify(item)})`)
    try {
      await this._database.db.put({
        ...this._serializer(item)
      })
      await this.notifyChange({ item, event: 'added' })
    } catch (error) {
      console.error('[LCT] [DAL] Error adding item to database:', error)
      throw error
    }
  }

  /**
   * Updates a single item in the database.
   * @param id - The Id of the item to update.
   * @param item - The item object containing the updated properties.
   * @returns A promise that resolves to void when the update is complete.
   * @throws Error if the operation fails or the document is not found.
   */
  async updateOne(
    id: string,
    item: TItem
  ): Promise<void> {
    console.debug(`[LCT] [DAL] db.${this._database.db.name}.updateOne(${id}, ${JSON.stringify(item)})`)
    try {
      const document = await this._database.db.get<TDbScheme>(id)
      const updatedDocument = { ...document, ...this._serializer(item) }
      const updatedItem = this._deserializer(updatedDocument)
      await this._database.db.put(updatedDocument)
      await this.notifyChange({ item: updatedItem, event: 'updated' })
    } catch (error) {
      console.error(`[LCT] [DAL] Error updating item ${id}:`, error)
      throw error
    }
  }

  /**
   * Partially updates an existing item in the database.
   * @param id - The Id of the item to patch.
   * @param item - The partial item object containing the fields to update.
   * @returns A promise that resolves to void when the update is complete.
   * @throws Error if the operation fails or the document is not found.
   */
  async patchOne(
    id: string,
    item: Partial<TItem>
  ): Promise<void> {
    console.debug(`[LCT] [DAL] db.${this._database.db.name}.patchOne(${id}, ${JSON.stringify(item)})`)
    try {
      const document = await this._database.db.get<TDbScheme>(id)
      const updatedItem = { ...this._deserializer(document), ...item }
      const updatedDocument = this._serializer(updatedItem)
      await this._database.db.put(updatedDocument)
      await this.notifyChange({ item: updatedItem, event: 'updated' })
    } catch (error) {
      console.error(`[LCT] [DAL] Error patching item ${id}:`, error)
      throw error
    }
  }

  /**
   * Removes a document from the database.
   * @param id The ID of the document to be removed.
   * @returns A promise that resolves when the document is successfully removed.
   * @throws Error if the operation fails or the document is not found.
   */
  async removeOne(
    id: string
  ): Promise<void> {
    console.debug(`[LCT] [DAL] db.${this._database.db.name}.removeOne(${id})`)
    try {
      const document = await this._database.db.get<TDbScheme>(id)
      const item = this._deserializer(document)
      await this._database.db.remove(document)
      await this.notifyChange({ item, event: 'removed' })
    } catch (error) {
      console.error(`[LCT] [DAL] Error removing item ${id}:`, error)
      throw error
    }
  }

  /**
   * Removes a document from the database by adding _deleted flag. It allows
   * deleted documents to be replicated and synced with other databases while using
   * filtered replication (See PouchDB documentation for more information).
   * @param id The ID of the document to be removed.
   * @returns A promise that resolves when the document is successfully removed.
   * @throws Error if the operation fails or the document is not found.
   */
  async softRemoveOne(
    id: string
  ): Promise<void> {
    console.debug(`[LCT] [DAL] db.${this._database.db.name}.softRemoveOne(${id})`)
    try {
      const document = await this._database.db.get<TDbScheme>(id)
      const updatedItem = { ...this._deserializer(document), _deleted: true } as TItem
      const updatedDocument = this._serializer(updatedItem)
      await this._database.db.put(updatedDocument)
      await this.notifyChange({ item: updatedItem, event: 'removed' })
    } catch (error) {
      console.error(`[LCT] [DAL] Error soft removing item ${id}:`, error)
      throw error
    }
  }
}
