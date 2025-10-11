import type { FindOneRequest, GetAllRequest, GetManyRequest, GetCountRequest, IRepository, Identifiable, ItemChangedEventHandler, UnsubscribeFn } from './IRepository'

/**
 * A caching wrapper around IRepository that stores query results in memory.
 *
 * Caching strategy:
 * - All read operations (getOne, findOne, getAll, getMany, getIds, getCount) are cached
 * - Cache keys are generated based on method name and parameters
 * - Mutations (addOne, updateOne, patchOne, removeOne) selectively invalidate cache:
 *   - addOne: updates single item cache, invalidates list queries
 *   - updateOne: updates single item cache, invalidates list queries
 *   - patchOne: removes single item cache, invalidates list queries
 *   - removeOne: removes single item cache, invalidates all queries
 *
 * @template TItem - The item type returned by repository methods
 * @template TDbScheme - The database schema type used for queries
 */
export class CachingRepository<
  TItem extends Identifiable,
  TDbScheme extends Identifiable,
> implements IRepository<TItem, TDbScheme> {
  private _cache: Map<string, any> = new Map()

  /**
   * Creates a new caching repository wrapper.
   * @param repo - The underlying repository to wrap with caching
   */
  constructor(
    private readonly repo: IRepository<TItem, TDbScheme>
  ) {}

  /**
   * Invalidates the entire cache.
   */
  public invalidateCache() {
    this._cache.clear()
    console.log('[LCT] [DAL] Invalidate cache')
  }

  /**
   * Subscribes to item change events from the underlying repository.
   * @param handler - The event handler to call on changes
   * @returns A function to unsubscribe
   */
  public subscribe(
    handler: ItemChangedEventHandler<TItem>
  ): UnsubscribeFn {
    return this.repo.subscribe(handler)
  }

  /**
   * Retrieves a single item by ID. Result is cached.
   * @param id - The item ID
   * @returns The item
   * @throws Error if item not found
   */
  async getOne(
    id: string
  ): Promise<TItem> {
    const cacheKey = this.getCacheKey('getOne', id)
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey)
    }

    const result = await this.repo.getOne(id)
    this._cache.set(cacheKey, result)
    return result
  }

  /**
   * Finds a single item matching the criteria. Result is cached.
   * @param request - The search criteria
   * @returns The item or undefined if not found
   */
  async findOne(
    request: FindOneRequest<TDbScheme>
  ): Promise<TItem | undefined> {
    const cacheKey = this.getCacheKey('findOne', request)
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey)
    }

    const result = await this.repo.findOne(request)
    this._cache.set(cacheKey, result)
    return result
  }

  /**
   * Retrieves all items with optional pagination/sorting. Result is cached.
   * @param request - Optional pagination and sorting parameters
   * @returns Array of items
   */
  async getAll(
    request?: GetAllRequest
  ): Promise<TItem[]> {
    const cacheKey = this.getCacheKey('getAll', request ?? {})
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey)
    }

    const items = await this.repo.getAll(request)
    this._cache.set(cacheKey, items)
    for (const item of items) {
      const cacheKey = this.getCacheKey('getOne', item._id)
      this._cache.set(cacheKey, item)
    }
    return items
  }

  /**
   * Retrieves multiple items matching criteria. Result is cached.
   * @param request - Search, pagination, and field selection criteria
   * @returns Array of items
   */
  async getMany(
    request: GetManyRequest<TDbScheme>
  ): Promise<TItem[]> {
    const cacheKey = this.getCacheKey('getMany', request)
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey)
    }

    const items = await this.repo.getMany(request)
    this._cache.set(cacheKey, items)
    for (const item of items) {
      const cacheKey = this.getCacheKey('getOne', item._id)
      this._cache.set(cacheKey, item)
    }
    return items
  }

  /**
   * Retrieves IDs of items matching criteria. Result is cached.
   * @param request - Search and pagination criteria
   * @returns Array of item IDs
   */
  async getIds(
    request: GetManyRequest<TDbScheme>
  ): Promise<string[]> {
    const cacheKey = this.getCacheKey('getIds', request)
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey)
    }

    const result = await this.repo.getIds(request)
    this._cache.set(cacheKey, result)
    return result
  }

  /**
   * Gets count of items, optionally filtered. Result is cached.
   * @param request - Optional filter criteria
   * @returns Item count
   */
  async getCount(request?: GetCountRequest<TDbScheme>): Promise<number> {
    const cacheKey = this.getCacheKey('getCount', request ?? {})
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey)
    }

    const result = await this.repo.getCount(request)
    this._cache.set(cacheKey, result)
    return result
  }

  /**
   * Adds a new item. Updates item cache and invalidates list queries.
   * @param item - The item to add
   */
  async addOne(
    item: TItem
  ): Promise<void> {
    await this.repo.addOne(item)
    this._cache.set(this.getCacheKey('getOne', item._id), item)
    this.invalidateQueries('getAll:', 'getMany:', 'getIds:', 'getCount:')
  }

  /**
   * Updates an item completely. Updates item cache and invalidates list queries.
   * @param id - The item ID
   * @param item - The new item data
   */
  async updateOne(
    id: string,
    item: TItem
  ): Promise<void> {
    await this.repo.updateOne(id, item)
    this._cache.set(this.getCacheKey('getOne', id), item)
    this.invalidateQueries('getAll:', 'getMany:', 'findOne:')
  }

  /**
   * Partially updates an item. Removes item cache and invalidates list queries.
   * @param id - The item ID
   * @param item - Partial item data to merge
   */
  async patchOne(
    id: string,
    item: Partial<TItem>
  ): Promise<void> {
    await this.repo.patchOne(id, item)
    this._cache.delete(this.getCacheKey('getOne', id))
    this.invalidateQueries('getAll:', 'getMany:', 'findOne:')
  }

  /**
   * Removes an item. Removes item cache and invalidates all queries.
   * @param id - The item ID
   */
  async removeOne(
    id: string
  ): Promise<void> {
    await this.repo.removeOne(id)
    this._cache.delete(this.getCacheKey('getOne', id))
    this.invalidateQueries('getAll:', 'getMany:', 'getIds:', 'getCount:', 'findOne:')
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Private                                  */
  /* -------------------------------------------------------------------------- */
  
  /**
   * Invalidates cached queries that match the given prefixes.
   * @param prefixes - Cache key prefixes to match and invalidate
   * @private
   */
  private invalidateQueries(...prefixes: string[]) {
    for (const key of this._cache.keys()) {
      if (prefixes.some(prefix => key.startsWith(prefix))) {
        this._cache.delete(key)
      }
    }
  }

  /**
   * Generates a cache key from method name and parameters.
   * @param method - The method name (e.g., 'getOne', 'getMany')
   * @param params - The parameters passed to the method
   * @returns A string cache key
   * @private
   */
  private getCacheKey(method: string, params: any): string {
    return `${method}:${JSON.stringify(params)}`
  }
}
