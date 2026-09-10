import { Platform } from "react-native";
import * as Notifications from "expo-notifications";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function configureNotifications() {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync("agnes-completed", {
    name: "Agnes AI — готово",
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 150, 250],
    sound: "default",
  });
}

export async function requestNotificationAccess() {
  const current = await Notifications.getPermissionsAsync();
  if (current.status === "undetermined") return Notifications.requestPermissionsAsync();
  return current;
}

export async function notifyGenerationCompleted(task: { id: string; kind: "image" | "video"; localUri?: string; resultUrl?: string }) {
  const permission = await requestNotificationAccess();
  if (permission.status !== "granted") return;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: task.kind === "video" ? "Видео готово" : "Изображение готово",
      body: task.localUri ? "Файл сохранён в альбоме Agnes-AI" : "Нажмите, чтобы открыть результат",
      sound: "default",
      data: { taskId: task.id, uri: task.localUri || task.resultUrl },
    },
    trigger: null,
  });
}
