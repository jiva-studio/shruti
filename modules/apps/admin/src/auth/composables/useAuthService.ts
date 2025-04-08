import { useConfig } from '@lectorium/admin/shared'
import { AuthService } from '../services/AuthService'

export function useAuthService() {
  const config = useConfig()
  return new AuthService(config.apiUrl)
}
