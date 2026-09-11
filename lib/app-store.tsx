import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";

import { AgnesApiError, buildNativePayload, pollVideo, saveResultLocally, submitImage, submitVideo } from "@/lib/agnes-api";
import { loadPersistedState, persistState } from "@/lib/storage";
import { DEFAULT_SETTINGS, type ApiProfile, type AppSettings, type GenerationTask, type HistoryItem, type PersistedState } from "@/lib/types";
import { notifyGenerationCompleted } from "@/lib/notifications";
import { cancelNativeGeneration, getNativeGenerationStatus, hasNativeForegroundService, startNativeGeneration } from "@/lib/native-work-manager";

const AppStoreContext = createContext<{
  hydrated: boolean;
  profiles: ApiProfile[];
  sharedImgbbKey: string;
  settings: AppSettings;
  tasks: GenerationTask[];
  history: HistoryItem[];
  addTask: (task: GenerationTask) => void;
  updateTask: (id: string, patch: Partial<GenerationTask>) => void;
  saveTaskResult: (id: string) => void;
  retryTask: (id: string) => void;
  cancelTask: (id: string) => void;
  removeTask: (id: string) => void;
  saveProfile: (profile: ApiProfile) => void;
  removeProfile: (id: string) => void;
  setSharedImgbbKey: (key: string) => void;
  setSettings: (patch: Partial<AppSettings>) => void;
  clearHistory: () => void;
}>({
  hydrated: false,
  profiles: [],
  sharedImgbbKey: "",
  settings: DEFAULT_SETTINGS,
  tasks: [],
  history: [],
  addTask: () => undefined,
  updateTask: () => undefined,
  saveTaskResult: () => undefined,
  retryTask: () => undefined,
  cancelTask: () => undefined,
  removeTask: () => undefined,
  saveProfile: () => undefined,
  removeProfile: () => undefined,
  setSharedImgbbKey: () => undefined,
  setSettings: () => undefined,
  clearHistory: () => undefined,
});

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function AppStoreProvider({ children }: PropsWithChildren) {
  const [hydrated, setHydrated] = useState(false);
  const [state, setState] = useState<PersistedState>({ profiles: [], sharedImgbbKey: "", settings: DEFAULT_SETTINGS, tasks: [], history: [] });
  const runningRef = useRef(new Set<string>());
  const cancelledRef = useRef(new Set<string>());
  const lastSubmittedRef = useRef<Record<string, number>>({});
  const pausedLanesRef = useRef(new Set<string>());

  useEffect(() => {
    loadPersistedState().then((loaded) => {
      loaded.tasks = loaded.tasks.map((task) => ["preparing", "submitting", "processing", "retry_wait"].includes(task.status)
        ? { ...task, status: "processing", stage: "Восстановление фоновой генерации", progress: Math.max(5, Math.min(task.progress, 95)), updatedAt: Date.now() }
        : task);
      setState(loaded);
      setHydrated(true);
    });
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    persistState(state).catch(() => undefined);
  }, [state, hydrated]);

  useEffect(() => {
    if (!hydrated || !hasNativeForegroundService()) return;
    let stopped = false;
    const syncNativeResults = async () => {
      const candidates = state.tasks.filter((task) =>
        ["preparing", "submitting", "processing", "retry_wait", "failed"].includes(task.status),
      );
      for (const task of candidates) {
        if (stopped) return;
        try {
          const nativeState = await getNativeGenerationStatus(task.id);
          if (nativeState.state === "NOT_FOUND") continue;
          if (["SUBMITTING", "RETRY_WAIT", "RATE_LIMITED", "PROCESSING"].includes(nativeState.state)) {
            updateTaskInternal(task.id, {
              status: "processing",
              stage: nativeState.state === "RATE_LIMITED" ? "Ожидание лимита Agnes API" : nativeState.state === "RETRY_WAIT" ? "Ожидание повтора сетевого запроса" : "Восстановление фоновой генерации",
              progress: nativeState.progress || Math.max(5, task.progress),
              serverId: nativeState.serverId,
              resultUrl: nativeState.resultUrl,
              errorCode: nativeState.errorCode,
              errorMessage: nativeState.errorMessage,
            });
            continue;
          }
          if (nativeState.state !== "SERVER_READY" || !nativeState.resultUrl) continue;
          const completedAt = Date.now();
          const effectiveStartedAt = nativeState.startedAt || task.startedAt || task.createdAt;
          const generationDuration = Math.max(0, completedAt - effectiveStartedAt);
          updateTaskInternal(task.id, { status: "completed", stage: "Видео готово на сервере", progress: 100, serverId: nativeState.serverId, resultUrl: nativeState.resultUrl, completedAt, durationMs: generationDuration, errorCode: undefined, errorMessage: undefined });
          recordHistory(task, nativeState.resultUrl, completedAt, generationDuration);
          let localUri: string | undefined;
          try { localUri = await saveResultLocally(nativeState.resultUrl, task); } catch { localUri = undefined; }
          updateTaskInternal(task.id, { localUri, stage: localUri ? `${task.kind === "video" ? "Видео" : "Изображение"} сохранено на устройстве` : `${task.kind === "video" ? "Видео" : "Изображение"} готово на сервере` });
          if (localUri) recordHistory(task, nativeState.resultUrl, completedAt, generationDuration, localUri);
          if (state.settings.notifications) await notifyGenerationCompleted({ id: task.id, kind: task.kind, localUri, resultUrl: nativeState.resultUrl });
        } catch {
          // Native polling остаётся источником истины; временный сбой синхронизации не меняет статус задачи.
        }
      }
    };
    void syncNativeResults();
    const timer = setInterval(() => { void syncNativeResults(); }, 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, [hydrated, state.tasks, state.settings.notifications]);

  const updateTaskInternal = (id: string, patch: Partial<GenerationTask>) => {
    setState((current) => ({
      ...current,
      tasks: current.tasks.map((task) => task.id === id ? { ...task, ...patch, updatedAt: Date.now() } : task),
    }));
  };

  const recordHistory = (task: GenerationTask, resultUrl: string, completedAt: number, durationMs: number, localUri?: string) => {
    const item: HistoryItem = { id: `history-${task.id}`, taskId: task.id, kind: task.kind, model: task.model, prompt: task.prompt, resultUrl, localUri, createdAt: task.createdAt, completedAt, durationMs };
    setState((current) => ({ ...current, history: [item, ...current.history.filter((entry) => entry.taskId !== task.id)] }));
  };

  const retryTaskInternal = (id: string) => {
    const retryTarget = state.tasks.find((task) => task.id === id);
    if (retryTarget) pausedLanesRef.current.delete(`${retryTarget.profileId}:${retryTarget.kind}`);
    setState((current) => ({
      ...current,
      tasks: current.tasks.map((task) => task.id === id ? { ...task, status: "queued", stage: "Готовится к повторной отправке", progress: 0, errorCode: undefined, errorMessage: undefined, resultUrl: undefined, localUri: undefined, updatedAt: Date.now() } : task),
    }));
  };

  useEffect(() => {
    if (!hydrated) return;
    const runnable = state.tasks.filter((task) => task.status === "queued");
    for (const task of runnable) {
      const profile = state.profiles.find((item) => item.id === task.profileId);
      const lane = `${task.profileId}:${task.kind}`;
      if (cancelledRef.current.has(task.id) || !profile?.enabled || !profile.agnesKey || runningRef.current.has(lane) || (!state.settings.autoContinue && pausedLanesRef.current.has(lane))) continue;
      runningRef.current.add(lane);

      void (async () => {
        let startedAt = 0;
        try {
          const interval = task.kind === "image" ? state.settings.minImageIntervalSec : state.settings.minVideoIntervalSec;
          const elapsed = Date.now() - (lastSubmittedRef.current[lane] ?? 0);
          if (elapsed < interval * 1000) await wait(interval * 1000 - elapsed);
          if (cancelledRef.current.has(task.id)) return;
          startedAt = Date.now();
          updateTaskInternal(task.id, { status: "preparing", stage: "Подготовка файлов и параметров", progress: 5, startedAt, completedAt: undefined, durationMs: undefined });
          await wait(250);
          updateTaskInternal(task.id, { status: "submitting", stage: "Отправка запроса в Agnes AI", progress: 25 });

          const nativeEligible = hasNativeForegroundService();
          if (nativeEligible) {
            updateTaskInternal(task.id, { stage: "Подготовка Foreground Service", progress: 20 });
            const payload = await buildNativePayload(task, state.sharedImgbbKey);
            await startNativeGeneration(task.id, task.kind, profile.agnesKey, profile.id, payload, state.settings.pollIntervalSec);
            updateTaskInternal(task.id, { status: "processing", stage: "Foreground Service выполняет задачу", progress: 35 });
            let nativeState = await getNativeGenerationStatus(task.id);
            for (let startupCheck = 0; nativeState.state === "NOT_FOUND" && startupCheck < 10; startupCheck += 1) {
              await wait(1000);
              nativeState = await getNativeGenerationStatus(task.id);
            }
            while (["SUBMITTING", "RETRY_WAIT", "RATE_LIMITED", "PROCESSING"].includes(nativeState.state)) {
              await wait(3000);
              nativeState = await getNativeGenerationStatus(task.id);
              const nativeProgress = nativeState.progress || 35;
              const waitingStage = nativeState.state === "RATE_LIMITED"
                ? "Ожидание лимита Agnes API"
                : nativeState.state === "RETRY_WAIT"
                  ? "Ожидание повтора сетевого запроса"
                  : nativeState.state === "SUBMITTING"
                    ? "Отправка задачи в Agnes API"
                    : "Foreground Service выполняет задачу";
              updateTaskInternal(task.id, { status: "processing", stage: waitingStage, progress: nativeProgress, attempts: nativeState.runAttemptCount, serverId: nativeState.serverId, resultUrl: nativeState.resultUrl, errorCode: nativeState.errorCode, errorMessage: nativeState.errorMessage });
            }
            const completedAt = Date.now();
            if (nativeState.state === "SERVER_READY" && nativeState.resultUrl) {
              const effectiveStartedAt = nativeState.startedAt || startedAt;
              const generationDuration = Math.max(0, completedAt - effectiveStartedAt);
              updateTaskInternal(task.id, { status: "completed", stage: "Видео готово на сервере", progress: 100, serverId: nativeState.serverId, resultUrl: nativeState.resultUrl, completedAt, durationMs: generationDuration, errorMessage: undefined, errorCode: undefined });
              recordHistory(task, nativeState.resultUrl, completedAt, generationDuration);
              let localUri: string | undefined;
              try { localUri = await saveResultLocally(nativeState.resultUrl, task); } catch { localUri = undefined; }
              updateTaskInternal(task.id, { localUri, stage: localUri ? `${task.kind === "video" ? "Видео" : "Изображение"} сохранено на устройстве` : `${task.kind === "video" ? "Видео" : "Изображение"} готово на сервере`, errorMessage: undefined, errorCode: undefined });
              if (localUri) recordHistory(task, nativeState.resultUrl, completedAt, generationDuration, localUri);
              if (state.settings.notifications) await notifyGenerationCompleted({ id: task.id, kind: task.kind, localUri, resultUrl: nativeState.resultUrl });
              return;
            }
            if (nativeState.state === "CANCELLED") throw new AgnesApiError("Задача отменена пользователем.", { retryable: false });
            throw new AgnesApiError(nativeState.errorMessage || "Foreground Service завершил задачу без результата.", { code: nativeState.errorCode, retryable: false });
          }

          const submitted = task.kind === "image"
            ? await submitImage(task, profile.agnesKey, state.sharedImgbbKey)
            : await submitVideo(task, profile.agnesKey, state.sharedImgbbKey);
          lastSubmittedRef.current[lane] = Date.now();

          if (task.kind === "image") {
            const completedAt = Date.now();
            const localUri = submitted.resultUrl ? await saveResultLocally(submitted.resultUrl, task) : undefined;
            const generationDuration = Math.max(0, completedAt - startedAt);
            updateTaskInternal(task.id, { status: "completed", stage: localUri ? "Изображение сохранено на устройстве" : "Изображение готово", progress: 100, serverId: submitted.serverId, resultUrl: submitted.resultUrl, localUri, completedAt, durationMs: generationDuration });
            if (submitted.resultUrl) recordHistory(task, submitted.resultUrl, completedAt, generationDuration, localUri);
            if (state.settings.notifications) await notifyGenerationCompleted({ id: task.id, kind: task.kind, localUri, resultUrl: submitted.resultUrl });
            if (!state.settings.autoContinue) pausedLanesRef.current.add(lane);
            return;
          }

          updateTaskInternal(task.id, { status: "processing", stage: "Рендеринг видео на сервере", progress: 40, serverId: submitted.serverId });
          let pollCount = 0;
          let finished = false;
          while (!finished && pollCount < 240) {
            await wait(Math.max(5, state.settings.pollIntervalSec) * 1000);
            pollCount += 1;
            const result = await pollVideo(submitted.serverId, profile.agnesKey, task.model);
            if (result.status === "completed" && result.resultUrl) {
              finished = true;
              const completedAt = Date.now();
              const localUri = await saveResultLocally(result.resultUrl, task);
              const generationDuration = Math.max(0, completedAt - startedAt);
              updateTaskInternal(task.id, { status: "completed", stage: localUri ? "Видео сохранено на устройстве" : "Видео готово", progress: 100, resultUrl: result.resultUrl, localUri, completedAt, durationMs: generationDuration });
              recordHistory(task, result.resultUrl, completedAt, generationDuration, localUri);
              if (state.settings.notifications) await notifyGenerationCompleted({ id: task.id, kind: task.kind, localUri, resultUrl: result.resultUrl });
              if (!state.settings.autoContinue) pausedLanesRef.current.add(lane);
            } else {
              const progress = Math.min(95, 40 + pollCount * 3);
              updateTaskInternal(task.id, { status: "processing", stage: `Рендеринг видео · опрос ${pollCount}`, progress });
            }
          }
          if (!finished) throw new AgnesApiError("Истекло максимальное время ожидания статуса видео.");
        } catch (error) {
          const apiError = error instanceof AgnesApiError ? error : new AgnesApiError(error instanceof Error ? error.message : "Неизвестная ошибка");
          const attempts = (task.attempts ?? 0) + 1;
          const canRetry = apiError.retryable && attempts <= state.settings.maxAutoRetries;
          if (canRetry) {
            const delay = Math.min(state.settings.retryBaseSec * 2 ** (attempts - 1), 15 * 60);
            updateTaskInternal(task.id, { status: "retry_wait", stage: `Повтор через ${delay} сек.`, progress: Math.max(5, task.progress), attempts, errorCode: apiError.code, errorMessage: apiError.message });
            setTimeout(() => retryTaskInternal(task.id), delay * 1000);
          } else {
            if (!state.settings.autoContinue) pausedLanesRef.current.add(lane);
            const completedAt = Date.now();
            updateTaskInternal(task.id, { status: "failed", stage: "Генерация завершилась ошибкой", progress: 100, attempts, errorCode: apiError.code, errorMessage: apiError.message, completedAt, durationMs: startedAt ? completedAt - startedAt : undefined });
          }
        } finally {
          runningRef.current.delete(lane);
        }
      })();
    }
  }, [hydrated, state.tasks, state.profiles, state.sharedImgbbKey, state.settings]);

  const value = useMemo(() => ({
    hydrated,
    ...state,
    addTask: (task: GenerationTask) => {
      pausedLanesRef.current.delete(`${task.profileId}:${task.kind}`);
      setState((current) => ({ ...current, tasks: [task, ...current.tasks] }));
    },
    updateTask: updateTaskInternal,
    saveTaskResult: (id: string) => {
      const target = state.tasks.find((task) => task.id === id);
      if (!target?.resultUrl || target.localUri) return;
      void saveResultLocally(target.resultUrl, target).then((localUri) => {
        if (localUri) updateTaskInternal(id, { localUri, stage: target.kind === "video" ? "Видео сохранено на устройстве" : "Изображение сохранено на устройстве", errorMessage: undefined });
        else updateTaskInternal(id, { stage: "Не удалось сохранить результат", errorMessage: "Android не вернул URI MediaStore. Повторите сохранение или проверьте, что установлена native APK-версия." });
      }).catch((error) => updateTaskInternal(id, { stage: "Ошибка сохранения", errorMessage: error instanceof Error ? error.message : "Не удалось сохранить результат." }));
    },
    retryTask: retryTaskInternal,
    cancelTask: (id: string) => {
      cancelledRef.current.add(id);
      const target = state.tasks.find((task) => task.id === id);
      if (target && ["preparing", "submitting", "processing", "retry_wait"].includes(target.status) && hasNativeForegroundService()) void cancelNativeGeneration(id);
      setState((current) => ({ ...current, tasks: current.tasks.map((task) => task.id === id && ["queued", "preparing", "submitting", "processing", "retry_wait"].includes(task.status) ? { ...task, status: "cancelled", stage: "Отменено пользователем", completedAt: Date.now(), updatedAt: Date.now() } : task) }));
    },
    removeTask: (id: string) => setState((current) => ({ ...current, tasks: current.tasks.filter((task) => task.id !== id || !["queued", "completed", "failed", "cancelled"].includes(task.status)) })),
    saveProfile: (profile: ApiProfile) => setState((current) => ({
      ...current,
      profiles: current.profiles.some((item) => item.id === profile.id) ? current.profiles.map((item) => item.id === profile.id ? profile : item) : [...current.profiles, profile],
    })),
    removeProfile: (id: string) => setState((current) => ({ ...current, profiles: current.profiles.filter((profile) => profile.id !== id) })),
    setSharedImgbbKey: (sharedImgbbKey: string) => setState((current) => ({ ...current, sharedImgbbKey })),
    setSettings: (patch: Partial<AppSettings>) => setState((current) => ({ ...current, settings: { ...current.settings, ...patch } })),
    clearHistory: () => setState((current) => ({ ...current, history: [] })),
  }), [hydrated, state]);

  return <AppStoreContext.Provider value={value}>{children}</AppStoreContext.Provider>;
}

export function useAppStore() {
  return useContext(AppStoreContext);
}

export async function resetPrototypeStorage() {
  await AsyncStorage.removeItem("agnes-ai-mobile-state-v1");
}
