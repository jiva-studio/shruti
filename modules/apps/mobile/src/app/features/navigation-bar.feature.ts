import { NavigationBar } from '@squareetlabs/capacitor-navigation-bar'

export async function initNavigationBarFeature() {
  await NavigationBar.setColor({ color: '#ffffff', darkButtons: true })
  await NavigationBar.setTransparency({ isTransparent: false })
}