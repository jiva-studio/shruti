type ConnectionHandler<TResult = void, TArgument = void> = (arg: TArgument) => TResult
export class Connection<TResult = void, TArgument = void> {
  private _handler?: ConnectionHandler<TResult, TArgument> = undefined

  public connect(handler: ConnectionHandler<TResult, TArgument>): void {
    if (this._handler) { throw new Error('Handler already added') }
    this._handler = handler
  }

  public disconnect(): void {
    this._handler = undefined

  }

  public call(arg: TArgument): TResult {
    if (!this._handler) { throw new Error('Handler not connected') }
    return this._handler(arg)
  }
}