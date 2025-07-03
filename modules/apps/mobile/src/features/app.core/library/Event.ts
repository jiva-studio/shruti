type EventHandler<TArgument> = (arg: TArgument) => Promise<void>

export class Event<TArgument> {
  private _handlers: EventHandler<TArgument>[] = []

  constructor(private readonly name?: string) {
  }

  /**
   * Subscribes to the event.
   * @param handler Handler to add.
   */
  public subscribe(handler: EventHandler<TArgument>): void {
    if (this._handlers.includes(handler)) {
      throw new Error('Handler already added')
    }
    this._handlers.push(handler)
  }

  /**
   * Unsubscribes from the event.
   * @param handler Handler to remove.
   */
  public unsubscribe(handler: EventHandler<TArgument>): void {
    const index = this._handlers.indexOf(handler)
    if (index !== -1) {
      this._handlers.splice(index, 1)
    } else {
      throw new Error('Handler not found')
    }
  }

  /**
   * Notifies all handlers.
   * @param arg Argument to pass to the handlers.
   */
  public async notify(arg: TArgument): Promise<void> {
    console.log(`[LCT] Event ${this.name || '???'}: ${JSON.stringify(arg)}`)
    await Promise.all(this._handlers.map(x => x(arg)))
  }
}