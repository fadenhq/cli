import type { CliConfig } from "./config.js";

/** Thin REST client over the faden API, authenticating with the workspace API key. */
export class ApiClient {
  constructor(private readonly config: CliConfig) {}

  private async request<T>(method: string, path: string, body?: unknown, rawBody?: BodyInit): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.config.apiKey}` };
    let payload: BodyInit | undefined = rawBody;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${this.config.apiUrl}${path}`, { method, headers, body: payload });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const detail = JSON.stringify(json);
      throw new Error(`${method} ${path} → ${res.status}: ${detail}`);
    }
    return json as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }
  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }
  postRaw<T>(path: string, rawBody: BodyInit): Promise<T> {
    return this.request<T>("POST", path, undefined, rawBody);
  }
  putRaw<T>(path: string, rawBody: BodyInit): Promise<T> {
    return this.request<T>("PUT", path, undefined, rawBody);
  }
  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }
}
