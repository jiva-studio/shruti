export type AuthenticationResponse = {
  accessToken: string;
  refreshToken: string;
  userFirstName: string;
  userLastName: string;
  userId: string;
  userImageUrl: string | null;
}