// import axios from 'axios'
// import { useAuthService, useAuthTokens } from './auth'

export function configureAxios() {
  // axios.interceptors.request.use(function (config) {
  //   const tokens = useAuthTokens()
  //   console.log(tokens.value.accessToken)
  //   config.headers['Authorization'] = `Bearer ${tokens.value.accessToken}`
  //   return config
  // })
  // axios.interceptors.response.use(
  //   function (response) {
  //     return response
  //   },
  //   async function (response) {
  //     console.error('Response Error:', response)
  //     console.log('Response:', response)
  //     const tokens = useAuthTokens()
  //     // && response.config.url !== '/auth/refresh'
  //     if (response.status === 401 && tokens.value.refreshToken) {
  //       console.log('Refreshing token')
  //       const authService = useAuthService()
  //       const response = await authService.refreshToken({
  //         refreshToken: tokens.value.refreshToken,
  //       })
  //       if (response.accessToken) {
  //         tokens.value = {
  //           accessToken: response.accessToken,
  //           refreshToken: response.refreshToken,
  //         }
  //         console.log(response)
  //       }
  //     }
  //     return axios.request(response.config)
  //     // return Promise.reject(error)
  //   },
  // )
}
