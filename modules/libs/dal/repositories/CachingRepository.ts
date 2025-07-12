import type { FindOneRequest, GetAllRequest, GetManyRequest, IRepository, Identifiable, ItemChangedEventHandler } from './IRepository'

export class CachingRepository<
  TItem extends Identifiable,
  TDbScheme extends Identifiable,
> implements IRepository<TItem, TDbScheme> {
  private _cacheAllLoaded: boolean = false
  private _cache: Map<string, TItem> = new Map()

  constructor(
    private readonly repo: IRepository<TItem, TDbScheme>
  ) {
  }

  public invalidateCache() {
    this._cache.clear()
    this._cacheAllLoaded = false
  }

  public subscribe(
    handler: ItemChangedEventHandler<TItem>
  ) {
    this.repo.subscribe(handler)
  }

  private generateCacheKey(obj: any): string {
    return JSON.stringify(obj)
  }

  async getOne(
    id: string
  ): Promise<TItem> {
    const cacheKey = this.generateCacheKey(id)
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey)! 
    }

    const result = await this.repo.getOne(id)
    if (result) { 
      this._cache.set(cacheKey, result) 
    }
    return result
  }

  async findOne(
    request: FindOneRequest<TDbScheme>
  ): Promise<TItem | undefined> {
    return this.repo.findOne(request)
  }

  async getAll(
    request?: GetAllRequest
  ): Promise<TItem[]> {
    if (!this._cacheAllLoaded) {
      const items = await this.repo.getAll(request)
      for (const item of items) {
        const cacheKey = this.generateCacheKey(item._id)
        this._cache.set(cacheKey, item)
      }
      this._cacheAllLoaded = true
      return items
    }
    return Array.from(this._cache.values())
  }

  async getMany(
    request: GetManyRequest
  ): Promise<TItem[]> {
    const result = await this.repo.getMany(request)
    for (const item of result) {
      const cacheKey = this.generateCacheKey(item._id)
      this._cache.set(cacheKey, item)
    }
    return result
  }

  async getIds(
    request: GetManyRequest
  ): Promise<string[]> {
    return this.repo.getIds(request)
  }

  async getCount(): Promise<number> {
    return this.repo.getCount()
  }

  async addOne(
    item: TItem
  ): Promise<void> {
    return this.repo.addOne(item)
  }

  async updateOne(
    id: string,
    item: TItem
  ): Promise<void> {
    return this.repo.updateOne(id, item)
  }

  async patchOne(
    id: string,
    item: Partial<TItem>
  ): Promise<void> {
    return this.repo.patchOne(id, item)
  }


  async removeOne(
    id: string
  ): Promise<void> {
    return this.repo.removeOne(id)
  }
}
