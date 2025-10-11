
export type Identifiable = { _id: string }

export type ItemChangedEvent<TItem> = {
  item: TItem,
  event: "added" | "removed" | "updated"
}

export type ItemChangedEventHandler<TItem> = (event: ItemChangedEvent<TItem>) => Promise<void>

export type UnsubscribeFn = () => void

export type FindOneRequest<TItem> = Partial<TItem>

export type GetAllRequest = {
  limit?: number
  skip?: number
  sort?: string[]
  useIndex?: [string, string]
}

export type Selector<TDbScheme = any> = {
  [K in keyof Partial<TDbScheme>]?: TDbScheme[K] | any
} & {
  [key: string]: any
}

export type GetManyRequest<TDbScheme = any> = {
  selector?: Selector<TDbScheme>
  limit?: number
  skip?: number
  sort?: string[]
  fields?: string[]
}

export type GetCountRequest<TDbScheme = any> = {
  selector?: Selector<TDbScheme>
}

export interface IRepository<
  TItem extends Identifiable,
  TDbScheme extends Identifiable = Identifiable
> {
  /**
   * Subscribes to item change events.
   * @param handler The event handler function to be called when an item changes.
   * @returns A function to unsubscribe from the events.
   */
  subscribe(handler: ItemChangedEventHandler<TItem>): UnsubscribeFn

  /**
   * Retrieves a single item by ID.
   * @param id The ID of the item to retrieve.
   * @returns A Promise that resolves to the item.
   * @throws Error if the item is not found.
   */
  getOne(id: string): Promise<TItem>

  /**
   * Finds a single item matching the request criteria.
   * @param request The search criteria.
   * @returns A Promise that resolves to the item or undefined if not found.
   */
  findOne(request: FindOneRequest<TDbScheme>): Promise<TItem | undefined>

  /**
   * Retrieves all items matching the request criteria.
   * @param request Optional pagination and sorting parameters.
   * @returns A Promise that resolves to an array of items.
   */
  getAll(request?: GetAllRequest): Promise<TItem[]>

  /**
   * Retrieves multiple items matching the request criteria.
   * @param request The search, pagination, and field selection criteria.
   * @returns A Promise that resolves to an array of items.
   */
  getMany(request: GetManyRequest<TDbScheme>): Promise<TItem[]>

  /**
   * Retrieves IDs of items matching the request criteria.
   * @param request The search and pagination criteria.
   * @returns A Promise that resolves to an array of IDs.
   */
  getIds(request: GetManyRequest<TDbScheme>): Promise<string[]>

  /**
   * Gets the count of items, optionally filtered by selector.
   * @param request Optional filter criteria.
   * @returns A Promise that resolves to the count.
   */
  getCount(request?: GetCountRequest<TDbScheme>): Promise<number>

  /**
   * Adds a new item to the repository.
   * @param item The item to add.
   * @returns A Promise that resolves when the operation completes.
   */
  addOne(item: TItem): Promise<void>

  /**
   * Updates an existing item, replacing all fields.
   * @param id The ID of the item to update.
   * @param item The new item data.
   * @returns A Promise that resolves when the operation completes.
   */
  updateOne(id: string, item: TItem): Promise<void>

  /**
   * Partially updates an existing item, merging with existing data.
   * @param id The ID of the item to patch.
   * @param item The partial item data to merge.
   * @returns A Promise that resolves when the operation completes.
   */
  patchOne(id: string, item: Partial<TItem>): Promise<void>

  /**
   * Removes an item from the repository.
   * @param id The ID of the item to remove.
   * @returns A Promise that resolves when the operation completes.
   */
  removeOne(id: string): Promise<void>
}