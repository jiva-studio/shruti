export const Routes = (baseUrl: string = '') => ({
  auth: {
    root: () => `${baseUrl}/auth`,
    signIn:  (method: string) => `${baseUrl}/auth/signin/${method}`,
    signOut: ()               => `${baseUrl}/auth/signout`,
    signup: (method: string) => `${baseUrl}/auth/signup/${method}`,
    tokens: {
      refresh: () => `${baseUrl}/auth/refresh`,
    },
    profile: () => `${baseUrl}/auth/profile`,
  },
  otp: {
    root: () => `${baseUrl}/auth/otp`,
  },
  bucket: {
    signUrl: () => `${baseUrl}/bucket/sign-url`,
  },
});
