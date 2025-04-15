
import { SafeArea, SafeAreaInsets } from 'capacitor-plugin-safe-area'
import { Device } from '@capacitor/device'

export async function initSafeAreaFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  const device = await Device.getInfo()
  const insets = await SafeArea.getSafeAreaInsets()

  /* -------------------------------------------------------------------------- */
  /*                               Initialization                               */
  /* -------------------------------------------------------------------------- */

  applyInsets(insets)
  
  /* -------------------------------------------------------------------------- */
  /*                                   Events                                   */
  /* -------------------------------------------------------------------------- */

  await SafeArea.addListener('safeAreaChanged', (data) => {
    applyInsets(data)
  })

  /* -------------------------------------------------------------------------- */
  /*                                   Helpers                                  */
  /* -------------------------------------------------------------------------- */

  function applyInsets(data: SafeAreaInsets) {
    const webViewVersion = device.webViewVersion.split('.').map(x => parseInt(x, 10))
    
    // Starting from some version of WebView, the safe area insets are applied
    // automatically. We need to check the version and skip applying insets if
    // the version is earlier than the one that supports it.
    // TODO: find the exact version
    if (isFirstVersionEarlier(webViewVersion, [128, 0, 0, 0])) {
      console.warn(
        `SafeArea: WebView version: ${device.webViewVersion}. ` +
        `Skipping safe area insets.`
      )
      return
    } else {
      console.log(
        `SafeArea: WebView version: ${device.webViewVersion}. ` +
        `Applying safe area insets.`,
      )
    }

    for (const [key, value] of Object.entries(data.insets)) {
      console.log(`SafeArea: ${key}: ${value}px`)
      document.documentElement.style.setProperty(
        `--ion-safe-area-${key}`,
        `${value}px`,
      )
    }
  }
}


function isFirstVersionEarlier(first: number[], second: number[]): boolean {
  for (let i = 0; i < Math.max(first.length, second.length); i++) {
    const firstVal = i < first.length ? first[i] : 0
    const secondVal = i < second.length ? second[i] : 0
    
    if (firstVal < secondVal) return true
    if (firstVal > secondVal) return false
  }
  return false 
}