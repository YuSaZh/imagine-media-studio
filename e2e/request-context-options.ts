export function apiRequestContextOptions(baseURL: string, authorization: string) {
  return {
    baseURL,
    extraHTTPHeaders: { Authorization: authorization },
    storageState: { cookies: [], origins: [] },
  };
}
