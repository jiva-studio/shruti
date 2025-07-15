/**
 * Feature: Application Authentication
 * 
 * This module provides authentication functionality for the application,
 * including user sign-in, sign-out, and social authentication.
 */

export * from './models/AuthenticationResponse'
export * from './composables/useAppleAuthentication'
export * from './composables/useGoogleAuthentication'
export * from './composables/useUserAvatarDownloader'
export * from './composables/useAuthTokenRefresher'
export * from './composables/useAuth'
export { default as SignInSettingsItem } from './components/SignInSettingsItem.vue'
export { default as DeleteAccountDialog } from './components/DeleteAccountDialog.vue'