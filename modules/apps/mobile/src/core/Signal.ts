import { useDebounceFn } from '@vueuse/core'

type Handler<TResult> = (result: TResult) => void

export class Signal<TArgs extends any[] = [], TResult = void> {
  private fn: (...args: TArgs) => TResult | Promise<TResult>
  private subscribers: Handler<TResult>[] = []

  constructor(fn: (...args: TArgs) => TResult | Promise<TResult>) {
    this.fn = fn
  }

  async call(...args: TArgs): Promise<TResult> {
    const result = await this.fn(...args)
    this.subscribers.forEach(handler => handler(result))
    return result
  }

  onCompleted(handler: Handler<TResult>): void {
    this.subscribers.push(handler)
  }
}

export class DebouncedSignal<TArgs extends any[] = [], TResult = void> {
  private fn: (...args: TArgs) => TResult | Promise<TResult>
  private subscribers: Handler<TResult>[] = []
  private debouncedCall: (...args: TArgs) => void

  constructor(
    fn: (...args: TArgs) => TResult | Promise<TResult>,
    wait: number = 200,
    maxWait?: number
  ) {
    this.fn = fn

    this.debouncedCall = useDebounceFn(async (...args: TArgs) => {
      const result = await this.fn(...args)
      this.subscribers.forEach(handler => handler(result))
    }, wait, { maxWait })
  }

  call(...args: TArgs): void {
    this.debouncedCall(...args)
  }

  onCompleted(handler: Handler<TResult>): void {
    this.subscribers.push(handler)
  }
}

type VoidHandler = () => void | Promise<void>

export class BlockingSignal {
  private fn: VoidHandler
  private isRunning = false
  private shouldRunAgain = false
  private subscribers: VoidHandler[] = []

  constructor(fn: VoidHandler) {
    this.fn = fn
  }

  private async run() {
    this.isRunning = true
    this.shouldRunAgain = false

    await this.fn()
    this.subscribers.forEach(handler => handler())

    this.isRunning = false

    if (this.shouldRunAgain) {
      this.run()
    }
  }

  call(): void {
    if (this.isRunning) {
      this.shouldRunAgain = true
    } else {
      this.run()
    }
  }

  onCompleted(handler: VoidHandler): void {
    this.subscribers.push(handler)
  }
}