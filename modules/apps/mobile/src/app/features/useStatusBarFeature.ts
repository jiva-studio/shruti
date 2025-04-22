import { StatusBar, Animation } from '@capacitor/status-bar'
import { Capacitor } from '@capacitor/core'

export async function useStatusBarFeature() {
  if (Capacitor.getPlatform() === 'web') { return }
  await StatusBar.hide({ animation: Animation.None })
}