import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

import { DEFAULT_PROFILES, DEFAULT_SETTINGS, type AppSettings, type ApiProfile, type GenerationTask, type PersistedState } from "@/lib/types";

const STATE_KEY = "agnes-ai-mobile-state-v1";
const SECRET_PREFIX = "agnes-secret-v1-";

const fallbackState: PersistedState = {
  profiles: DEFAULT_PROFILES,
  sharedImgbbKey: "",
  settings: DEFAULT_SETTINGS,
  tasks: [],
  history: [],
};

async function readSecret(key: string) {
  try {
    const available = await SecureStore.isAvailableAsync();
    if (available) return (await SecureStore.getItemAsync(key)) ?? "";
  } catch {
    // Web and restricted preview environments may not expose SecureStore.
  }
  return (await AsyncStorage.getItem(key)) ?? "";
}

async function writeSecret(key: string, value: string) {
  try {
    const available = await SecureStore.isAvailableAsync();
    if (available) {
      await SecureStore.setItemAsync(key, value);
      return;
    }
  } catch {
    // Fall back to local storage for the browser prototype.
  }
  await AsyncStorage.setItem(key, value);
}

export async function loadPersistedState(): Promise<PersistedState> {
  try {
    const raw = await AsyncStorage.getItem(STATE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<PersistedState>) : {};
    const profiles = (parsed.profiles?.length ? parsed.profiles : DEFAULT_PROFILES).map((profile) => ({
      ...profile,
      agnesKey: "",
    }));

    for (const profile of profiles) {
      profile.agnesKey = await readSecret(`${SECRET_PREFIX}agnes-${profile.id}`);
    }

    const sharedImgbbKey = await readSecret(`${SECRET_PREFIX}imgbb-shared`);
    return {
      profiles,
      sharedImgbbKey,
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
      tasks: parsed.tasks ?? [],
      history: parsed.history ?? [],
    };
  } catch {
    return fallbackState;
  }
}

export async function persistState(state: PersistedState) {
  const metadataProfiles: ApiProfile[] = state.profiles.map(({ agnesKey: _agnesKey, ...profile }) => ({ ...profile, agnesKey: "" }));
  await AsyncStorage.setItem(STATE_KEY, JSON.stringify({ ...state, profiles: metadataProfiles }));

  for (const profile of state.profiles) {
    await writeSecret(`${SECRET_PREFIX}agnes-${profile.id}`, profile.agnesKey);
  }
  await writeSecret(`${SECRET_PREFIX}imgbb-shared`, state.sharedImgbbKey);
}

export async function clearPersistedState() {
  await AsyncStorage.removeItem(STATE_KEY);
}

export type StoreSnapshot = {
  profiles: ApiProfile[];
  sharedImgbbKey: string;
  settings: AppSettings;
  tasks: GenerationTask[];
};
