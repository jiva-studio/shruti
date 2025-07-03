export type AuthenticationResponse = {
  accessToken: string;
  refreshToken: string;
  userFirstName: string;
  userLastName: string;
  userEmail: string;
  avatarUrl: string | null;
}