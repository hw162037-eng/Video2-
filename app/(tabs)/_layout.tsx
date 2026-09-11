import { MaterialIcons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { HapticTab } from "@/components/haptic-tab";
import { useColors } from "@/hooks/use-colors";
import { useAppStore } from "@/lib/app-store";

export default function TabLayout() {
  const colors = useColors();
  const { tasks } = useAppStore();
  const activeTaskCount = tasks.filter((task) => ["queued", "preparing", "submitting", "processing", "retry_wait"].includes(task.status)).length;
  const insets = useSafeAreaInsets();
  const bottomPadding = Platform.OS === "web" ? 12 : Math.max(insets.bottom, 8);
  const tabBarHeight = 62 + bottomPadding;

  return <Tabs screenOptions={{ headerShown: false, tabBarButton: HapticTab, tabBarActiveTintColor: colors.tint, tabBarInactiveTintColor: "#6E8297", tabBarStyle: { paddingTop: 8, paddingBottom: bottomPadding, height: tabBarHeight, backgroundColor: "#0C1823", borderTopColor: "#20384B", borderTopWidth: 1 }, tabBarLabelStyle: { fontSize: 10, fontWeight: "700" } }}>
    <Tabs.Screen name="index" options={{ title: "Создать", tabBarIcon: ({ color, size }) => <MaterialIcons name="bolt" size={size} color={color} /> }} />
    <Tabs.Screen name="tasks" options={{ title: "Задачи", tabBarBadge: activeTaskCount > 0 ? (activeTaskCount > 99 ? "99+" : String(activeTaskCount)) : undefined, tabBarBadgeStyle: { backgroundColor: "#FF7D85", color: "#07111D", fontSize: 9, fontWeight: "900" }, tabBarIcon: ({ color, size }) => <MaterialIcons name="format-list-bulleted" size={size} color={color} /> }} />
    <Tabs.Screen name="history" options={{ title: "История", tabBarIcon: ({ color, size }) => <MaterialIcons name="history" size={size} color={color} /> }} />
    <Tabs.Screen name="settings" options={{ title: "Настройки", tabBarIcon: ({ color, size }) => <MaterialIcons name="tune" size={size} color={color} /> }} />
  </Tabs>;
}
