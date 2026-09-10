import type { GenerationTask } from "./types";

export class AgnesApiError extends Error {
  code?: number;
  retryable: boolean;
  responseBody?: string;

  constructor(message: string, options?: { code?: number; retryable?: boolean; responseBody?: string }) {
    super(message);
    this.name = "AgnesApiError";
    this.code = options?.code;
    this.retryable = options?.retryable ?? false;
    this.responseBody = options?.responseBody;
  }
}

export function explainError(task: GenerationTask) {
  const code = String(task.errorCode ?? "");
  const messages: Record<string, string> = {
    "400": "Проверьте модель, режим, обязательные поля и формат параметров.",
    "401": "Agnes AI API key отклонён. Проверьте ключ в профиле.",
    "402": "Недостаточно баланса или квоты аккаунта.",
    "403": "У ключа нет доступа к выбранной модели или операции.",
    "404": "Проверьте endpoint, модель или video_id.",
    "413": "Файл или Base64-полезная нагрузка слишком большие.",
    "415": "Формат файла не поддерживается API.",
    "422": "Параметры запроса не прошли проверку модели.",
    "429": "Превышен RPM или квота. Задача будет повторена после паузы.",
    "500": "Временная ошибка сервера Agnes AI.",
    "502": "Сервис временно недоступен или вернул ошибку шлюза.",
    "503": "Сервис перегружен. Повторите позже.",
    "504": "Истёк таймаут upstream-сервиса.",
  };
  return messages[code] ?? "Проверьте сеть, параметры и ответ сервера.";
}
