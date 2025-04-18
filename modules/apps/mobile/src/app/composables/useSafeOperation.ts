import { toastController } from '@ionic/vue'

export function useSafeOperation() {
  async function execute(operation: () => Promise<void>) {
    try {
      await operation()
    } catch (error) {
      console.error('Error executing safe operation:', error)
      const toast = await toastController.create({
        message: 'An error occurred while performing the operation.',
        duration: 3500,
        position: 'top',
        color: 'danger',
      })
      await toast.present()
    }
  }

  return {
    execute,
  }
}