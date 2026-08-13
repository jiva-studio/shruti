import { Adb } from "./adapters/android/Adb.js"
import { AndroidAppLifecycle } from "./adapters/android/AndroidAppLifecycle.js"
import { AndroidAppStorage } from "./adapters/android/AndroidAppStorage.js"
import { AndroidClock } from "./adapters/android/AndroidClock.js"
import { AndroidConnectivity } from "./adapters/android/AndroidConnectivity.js"
import { AndroidDeviceLanguage } from "./adapters/android/AndroidDeviceLanguage.js"
import { AndroidDisplayCutout } from "./adapters/android/AndroidDisplayCutout.js"
import { AndroidListeningJournal } from "./adapters/android/AndroidListeningJournal.js"
import { AndroidLogs } from "./adapters/android/AndroidLogs.js"
import { AndroidMediaSession } from "./adapters/android/AndroidMediaSession.js"
import { AndroidPower } from "./adapters/android/AndroidPower.js"
import { AndroidStress } from "./adapters/android/AndroidStress.js"
import { AndroidAppInstall } from "./adapters/android/AndroidAppInstall.js"
import { AndroidSystemChooser } from "./adapters/android/AndroidSystemChooser.js"
import { AndroidUserDatabase } from "./adapters/android/AndroidUserDatabase.js"
import { AndroidWindowing } from "./adapters/android/AndroidWindowing.js"
import { AndroidMemory } from "./adapters/android/AndroidMemory.js"
import { AndroidMachine } from "./adapters/android/AndroidMachine.js"
import { AndroidNotificationSchedule } from "./adapters/android/AndroidNotificationSchedule.js"
import { AndroidPermissions } from "./adapters/android/AndroidPermissions.js"
import { AndroidSystemEvents } from "./adapters/android/AndroidSystemEvents.js"
import { AndroidSystemUi } from "./adapters/android/AndroidSystemUi.js"
import { EmulatorTelephony } from "./adapters/android/EmulatorTelephony.js"
import { WebView } from "./adapters/android/WebView.js"
import { WebViewEntitlement } from "./adapters/android/WebViewEntitlement.js"
import { MockBackend } from "./adapters/http/MockBackend.js"
import { Journeys, type JourneyScreens } from "./flows/Journeys.js"
import { ActivityCard } from "./screens/ActivityCard.js"
import { AppLanguage } from "./screens/AppLanguage.js"
import { AppTheme } from "./screens/AppTheme.js"
import { OnboardingScreen } from "./screens/OnboardingScreen.js"
import { PlayerBar } from "./screens/PlayerBar.js"
import { QueueScreen } from "./screens/QueueScreen.js"
import { SafeArea } from "./screens/SafeArea.js"
import { SearchScreen } from "./screens/SearchScreen.js"
import { SettingsScreen } from "./screens/SettingsScreen.js"
import { TabBar } from "./screens/TabBar.js"
import { ShareMenu } from "./screens/ShareMenu.js"
import { TrackSheet } from "./screens/TrackSheet.js"
import type { AppLifecycle } from "./ports/AppLifecycle.js"
import type { AppStorage } from "./ports/AppStorage.js"
import type { AppInstall } from "./ports/AppInstall.js"
import type { Backend } from "./ports/Backend.js"
import type { Connectivity } from "./ports/Connectivity.js"
import type { Entitlement } from "./ports/Entitlement.js"
import type { Clock } from "./ports/Clock.js"
import type { DeviceLanguage } from "./ports/DeviceLanguage.js"
import type { DisplayCutout } from "./ports/DisplayCutout.js"
import type { ListeningJournal } from "./ports/ListeningJournal.js"
import type { Logs } from "./ports/Logs.js"
import type { MediaSession } from "./ports/MediaSession.js"
import type { Memory } from "./ports/Memory.js"
import type { Machine } from "./ports/Machine.js"
import type { NotificationSchedule } from "./ports/NotificationSchedule.js"
import type { Permissions } from "./ports/Permissions.js"
import type { Power } from "./ports/Power.js"
import type { Stress } from "./ports/Stress.js"
import type { SystemEvents } from "./ports/SystemEvents.js"
import type { SystemUi } from "./ports/SystemUi.js"
import type { UserDatabase } from "./ports/UserDatabase.js"
import type { Windowing } from "./ports/Windowing.js"
import type { SystemChooser } from "./ports/SystemChooser.js"
import type { Telephony } from "./ports/Telephony.js"

export const APP_PACKAGE = "studio.jiva.shruti"
export const MAIN_ACTIVITY = ".MainActivity"

export interface World {
  readonly app: AppLifecycle
  readonly ui: SystemUi
  readonly net: Connectivity
  readonly entitlement: Entitlement
  readonly permissions: Permissions
  readonly power: Power
  readonly stress: Stress
  readonly events: SystemEvents
  readonly logs: Logs
  readonly storage: AppStorage
  readonly phone: Telephony
  readonly media: MediaSession
  readonly memory: Memory
  readonly clock: Clock
  readonly journal: ListeningJournal
  readonly notifications: NotificationSchedule
  readonly machine: Machine
  readonly cutout: DisplayCutout
  readonly windowing: Windowing
  readonly language: DeviceLanguage
  readonly install: AppInstall
  readonly userDb: UserDatabase
  readonly chooser: SystemChooser
  readonly backend: Backend
  readonly webView: WebView
  readonly screens: JourneyScreens
  readonly journeys: Journeys
}

let instance: World | undefined

/** Composition root: the only place adapters are chosen. */
export function world(): World {
  if (instance) return instance

  const adb = new Adb({
    serial: process.env.ANDROID_SERIAL ?? "emulator-5556",
    appPackage: APP_PACKAGE,
    mainActivity: MAIN_ACTIVITY,
  })
  const webView = new WebView(APP_PACKAGE)
  const screens: JourneyScreens = {
    onboarding: new OnboardingScreen(webView),
    tabs: new TabBar(webView),
    search: new SearchScreen(webView),
    sheet: new TrackSheet(webView),
    queue: new QueueScreen(webView),
    player: new PlayerBar(webView),
    theme: new AppTheme(webView),
    settings: new SettingsScreen(webView),
    activity: new ActivityCard(webView),
    appLanguage: new AppLanguage(webView),
    safeArea: new SafeArea(webView),
    shareMenu: new ShareMenu(webView),
  }

  instance = {
    app: new AndroidAppLifecycle(adb, webView),
    ui: new AndroidSystemUi(adb, webView),
    net: new AndroidConnectivity(adb),
    entitlement: new WebViewEntitlement(webView),
    permissions: new AndroidPermissions(adb),
    power: new AndroidPower(adb),
    stress: new AndroidStress(adb),
    events: new AndroidSystemEvents(adb),
    logs: new AndroidLogs(adb),
    storage: new AndroidAppStorage(adb),
    phone: new EmulatorTelephony(adb),
    clock: new AndroidClock(adb),
    journal: new AndroidListeningJournal(adb),
    notifications: new AndroidNotificationSchedule(adb),
    machine: new AndroidMachine(adb),
    cutout: new AndroidDisplayCutout(adb),
    windowing: new AndroidWindowing(adb),
    language: new AndroidDeviceLanguage(adb),
    install: new AndroidAppInstall(adb),
    userDb: new AndroidUserDatabase(adb),
    chooser: new AndroidSystemChooser(adb),
    media: new AndroidMediaSession(adb),
    memory: new AndroidMemory(adb),
    backend: new MockBackend(`http://localhost:${Number(process.env.MOCK_PORT ?? 11090)}`),
    webView,
    screens,
    journeys: new Journeys(screens),
  }
  return instance
}
