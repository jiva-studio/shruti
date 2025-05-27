import { toastController } from '@ionic/vue'

export type SafeOperationOptions = {
  operation: () => Promise<void>
  successMessage?: string
  errorMessage?: string
}

export function useSafeOperation() {
  async function execute(options: SafeOperationOptions) {
    try {
      await options.operation()

      if (options.successMessage) {
        const toast = await toastController.create({
          message: options.successMessage,
          duration: 3500,
          position: 'top',
          color: 'success',
        })
        await toast.present()
      }
    } catch (error) {
      console.error('Error executing safe operation: ', JSON.stringify(error))
      if (options.errorMessage) {
        const toast = await toastController.create({
          message: options.errorMessage,
          duration: 3500,
          position: 'top',
          color: 'danger',
        })
        await toast.present()
      }
    }
  }

  return {
    execute,
  }
}