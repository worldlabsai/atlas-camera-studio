export type GetToken = (() => Promise<string | null>) & {
  storageScope?: string;
};
export const appApiPath = (path: string) => path;
export async function authFetch(
  getToken: GetToken,
  path: string,
  init: RequestInit = {},
) {
  if (!path.startsWith("/api/") || path.includes("\\"))
    throw new Error("Unsupported API address");
  const token = await getToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok)
    throw new Error(
      (await response.json().catch(() => ({}))).error ||
        `Request failed (${response.status})`,
    );
  return response;
}
export async function authFetchJson<T>(
  getToken: GetToken,
  path: string,
  init?: RequestInit,
): Promise<T> {
  return (await authFetch(getToken, path, init)).json();
}
