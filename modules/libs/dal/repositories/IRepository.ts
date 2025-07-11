
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

export interface IRepository<
  TItem extends Identifiable, 
  TDbScheme extends Identifiable = Identifiable
> {
  subscribe(handler: ItemChangedEventHandler<TItem>): void

  getOne(id: string): Promise<TItem>
  findOne(request: FindOneRequest<TDbScheme>): Promise<TItem | undefined>
  getAll(request?: GetAllRequest): Promise<TItem[]>
  getMany(request: GetManyRequest): Promise<TItem[]>
  getIds(request: GetManyRequest): Promise<string[]>
  getCount(): Promise<number>

  addOne(item: TItem): Promise<void>
  updateOne(id: string, item: TItem): Promise<void>
  patchOne(id: string, item: Partial<TItem>): Promise<void>
  removeOne(id: string): Promise<void>
}