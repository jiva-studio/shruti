import { useConfig } from '@lectorium/admin/shared'
import { UserProfileService } from '../services/UserProfileService'

export function useUserProfileService() {
  const config = useConfig()
  return new UserProfileService(config.apiUrl)
}
