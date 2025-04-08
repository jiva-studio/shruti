import { useConfig } from '@shruti/admin/shared'
import { AuthService } from '../services/AuthService'

export function useAuthService() {
  const config = useConfig()
  return new AuthService(config.apiUrl)
}
