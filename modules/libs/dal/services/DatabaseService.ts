import { Database } from '../persistence'

export type Identifiable = { _id: string }

export type ItemChangedEvent<TItem> = {
  item: TItem,
  event: "added" | "removed" | "updated"
}

export type ItemChangedEventHandler<TItem> = (event: ItemChangedEvent<TItem>) => Promise<void>

export type FindOneRequest<TItem> = Partial<TItem>

export type GetAllRequest = {
  limit?: number
  skip?: number
  sort?: string[]
}

export type GetManyRequest = {
  selector?: any
  limit?: number
  skip?: number
  sort?: string[]
  fields?: string[]
}

export abstract class DatabaseService<
  TItem extends Identifiable,
  TDbScheme extends Identifiable,
> {
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
   */
  public subscribe(
    handler: ItemChangedEventHandler<TItem>
  ) {
    // TODO: unsubscribe
    this._changeEventHandlers.push(handler)
  }


  /**
   * Notifies all subscribers of a change event.
   * @param event The event to be broadcasted to all subscribers.
   */
  private async notifyChange(
    event: ItemChangedEvent<TItem>
  ) {
    for (const handler of this._changeEventHandlers) {
      await handler(event)
    }
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
    const response = await this._database.db.find(r)
    if (response.warning) {
      console.warn(response.warning, JSON.stringify(r))
    }
    return response.docs.map(row => this._deserializer(row as unknown as TDbScheme))
  }

  async getMany(
    request: GetManyRequest
  ): Promise<TItem[]> {
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

  /**
   * Retrieves the count of items in the database.
   * @returns A promise that resolves to the count of items in the database.
   */
  async getCount(): Promise<number> {
    const info = await this._database.db.info()
    return info.doc_count
  }

  /**
   * Adds an item to the database with the specified Id.
   * @param item The item to be added.
   * @returns A promise that resolves when the item is successfully added.
   */
  async addOne(
    item: TItem
  ): Promise<void> {
    try {
      await this._database.db.put({
        ...this._serializer(item)
      })
    } catch (error) {
      console.error('Error adding item to database', JSON.stringify(error))
    }
    await this.notifyChange({ item, event: 'added' })
  }

  /**
   * Updates a single item in the database.
   * @param id - The Id of the item to update.
   * @param item - The partial item object containing the updated properties.
   * @returns A promise that resolves to void when the update is complete.
   */
  async updateOne(
    id: string,
    item: TItem
  ): Promise<void> {
    const document = await this._database.db.get<TDbScheme>(id)
    const updatedDocument = { ...document, ...this._serializer(item) }
    const updatedItem = this._deserializer(updatedDocument)
    await this._database.db.put(updatedDocument)
    await this.notifyChange({ item: updatedItem, event: 'updated' })
  }

  async patchOne(
    id: string,
    item: Partial<TItem>
  ): Promise<void> {
    const document = await this._database.db.get<TDbScheme>(id)
    const updatedItem = { ...this._deserializer(document), ...item }
    const updatedDocument = this._serializer(updatedItem)
    await this._database.db.put(updatedDocument)
    await this.notifyChange({ item: updatedItem, event: 'updated' })
  }


  /**
   * Removes a document from the database.
   * @param id The ID of the document to be removed.
   * @returns A promise that resolves when the document is successfully removed.
   */
  async removeOne(
    id: string
  ): Promise<void> {
    const document = await this._database.db.get<TDbScheme>(id)
    const item = this._deserializer(document)
    await this._database.db.remove(document)
    await this.notifyChange({ item, event: 'removed' })
  }
}
