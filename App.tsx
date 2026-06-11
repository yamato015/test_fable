import { useEffect, useState } from 'react';
import {
  StyleSheet, Text, View, ActivityIndicator, Platform,
  TouchableOpacity, Modal, TextInput, FlatList, KeyboardAvoidingView,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import { findStationsWithDirection } from './src/utils/nearestStation';
import { Station, STATIONS } from './src/data/stations';
import { Theme, themes } from './src/theme';

type AppState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'success';
      station: Station;
      distanceKm: number;
      prevStation: Station | null;
      nextStation: Station | null;
    };

const THEME_STORAGE_KEY = 'imakoko_theme';

function loadSavedTheme(): Theme {
  if (Platform.OS === 'web') {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === 'blue' || saved === 'pink') return saved;
    } catch {}
  }
  return 'blue';
}

function saveTheme(theme: Theme) {
  if (Platform.OS === 'web') {
    try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch {}
  }
}

export default function App() {
  const [appState, setAppState] = useState<AppState>({ status: 'loading' });
  const [destination, setDestination] = useState<Station | null>(null);
  const [showDestPicker, setShowDestPicker] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [theme, setTheme] = useState<Theme>(loadSavedTheme);

  const t = themes[theme];

  function toggleTheme() {
    const next: Theme = theme === 'blue' ? 'pink' : 'blue';
    setTheme(next);
    saveTheme(next);
  }

  useEffect(() => {
    let subscription: Location.LocationSubscription | null = null;

    async function startWatchingLocation() {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setAppState({
          status: 'error',
          message: '位置情報の許可が必要です。\n設定アプリから許可してください。',
        });
        return;
      }

      const initialLocation = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const { latitude, longitude, heading } = initialLocation.coords;
      setAppState({ status: 'success', ...findStationsWithDirection(latitude, longitude, heading) });

      subscription = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, distanceInterval: 50, timeInterval: 5000 },
        (location) => {
          const { latitude, longitude, heading } = location.coords;
          setAppState({ status: 'success', ...findStationsWithDirection(latitude, longitude, heading) });
        }
      );
    }

    startWatchingLocation();
    return () => { subscription?.remove(); };
  }, []);

  const filteredStations = STATIONS.filter(s =>
    s.name.includes(searchQuery) || s.nameKana.includes(searchQuery)
  ).slice(0, 50);

  const isApproachingDestination =
    appState.status === 'success' &&
    destination !== null &&
    appState.nextStation?.name === destination.name;

  return (
    <View style={[styles.container, { backgroundColor: t.background }]}>
      <StatusBar style="light" />

      {/* ヘッダー行 */}
      <View style={styles.headerRow}>
        <Text style={[styles.appTitle, { color: t.accent }]}>いまここ！</Text>
        <TouchableOpacity style={[styles.themeButton, { borderColor: t.accent }]} onPress={toggleTheme}>
          <Text style={[styles.themeButtonText, { color: t.accent }]}>
            {theme === 'blue' ? '🩷 ピンク' : '💙 ブルー'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* 目的地設定ボタン */}
      <TouchableOpacity
        style={[styles.destButton, { borderColor: t.accent }]}
        onPress={() => setShowDestPicker(true)}
      >
        <Text style={[styles.destButtonText, { color: t.accent }]}>
          {destination ? `目的地　${destination.name}` : '目的地を設定する'}
        </Text>
      </TouchableOpacity>

      {appState.status === 'loading' && (
        <View style={styles.centerContent}>
          <ActivityIndicator size="large" color={t.accent} />
          <Text style={[styles.loadingText, { color: t.accentSoft }]}>現在地を取得中...</Text>
        </View>
      )}

      {appState.status === 'error' && (
        <View style={styles.centerContent}>
          <Text style={styles.errorIcon}>⚠️</Text>
          <Text style={styles.errorText}>{appState.message}</Text>
        </View>
      )}

      {appState.status === 'success' && (
        <View style={styles.centerContent}>

          {/* 前の駅 / 次の駅 */}
          <View style={styles.surroundingRow}>
            <Text style={[styles.surroundingStation, { color: t.textMuted }]} numberOfLines={1}>
              {appState.prevStation ? `← ${appState.prevStation.name}` : ''}
            </Text>
            <Text
              style={[
                styles.surroundingStation,
                appState.nextStation?.name === destination?.name
                  ? styles.surroundingStationAlert
                  : { color: t.textMuted },
              ]}
              numberOfLines={1}
            >
              {appState.nextStation ? `${appState.nextStation.name} →` : ''}
            </Text>
          </View>

          {/* 最寄り駅 */}
          <Text style={[styles.stationLabel, { color: t.accentSoft }]}>最寄り駅</Text>
          <Text style={[styles.stationName, { color: t.text }]}>{appState.station.name}</Text>
          <Text style={[styles.stationNameKana, { color: t.accentSoft }]}>{appState.station.nameKana}</Text>

          <View style={styles.linesContainer}>
            {appState.station.lines.map((line) => (
              <Text
                key={line}
                style={[styles.lineTag, { backgroundColor: t.lineTag, color: t.accent, borderColor: t.accent }]}
              >
                {line}
              </Text>
            ))}
          </View>

          <Text style={[styles.distanceText, { color: t.textMuted }]}>
            約 {appState.distanceKm < 1
              ? `${Math.round(appState.distanceKm * 1000)}m`
              : `${appState.distanceKm.toFixed(1)}km`}
          </Text>

          {/* 目的地到着アラート */}
          {isApproachingDestination && (
            <View style={[styles.alertBox, { backgroundColor: t.alertBg }]}>
              <Text style={styles.alertText}>まもなく {destination!.name} です</Text>
            </View>
          )}
        </View>
      )}

      {/* 目的地ピッカー */}
      <Modal visible={showDestPicker} animationType="slide" transparent>
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={[styles.modalContainer, { backgroundColor: t.modalBg }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: t.text }]}>目的地を選択</Text>
              <TouchableOpacity onPress={() => { setShowDestPicker(false); setSearchQuery(''); }}>
                <Text style={[styles.modalClose, { color: t.accent }]}>閉じる</Text>
              </TouchableOpacity>
            </View>

            {destination && (
              <TouchableOpacity
                style={[styles.clearButton, { backgroundColor: t.background }]}
                onPress={() => { setDestination(null); setShowDestPicker(false); setSearchQuery(''); }}
              >
                <Text style={styles.clearButtonText}>目的地をクリア</Text>
              </TouchableOpacity>
            )}

            <TextInput
              style={[styles.searchInput, { backgroundColor: t.inputBg, color: t.text, borderColor: t.accent }]}
              placeholder="駅名を入力..."
              placeholderTextColor={t.textMuted}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoFocus
            />

            <FlatList
              data={filteredStations}
              keyExtractor={(item) => item.name + item.lines[0]}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[styles.stationItem, { borderBottomColor: t.background }]}
                  onPress={() => {
                    setDestination(item);
                    setShowDestPicker(false);
                    setSearchQuery('');
                  }}
                >
                  <Text style={[styles.stationItemName, { color: t.text }]}>{item.name}</Text>
                  <Text style={[styles.stationItemLine, { color: t.textMuted }]}>{item.lines[0]}</Text>
                </TouchableOpacity>
              )}
            />
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    paddingTop: Platform.OS === 'ios' ? 60 : 40,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  appTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    letterSpacing: 4,
  },
  themeButton: {
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  themeButtonText: {
    fontSize: 12,
    letterSpacing: 1,
  },
  destButton: {
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 6,
    marginBottom: 8,
  },
  destButtonText: {
    fontSize: 13,
    letterSpacing: 1,
  },
  centerContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
    width: '100%',
  },
  surroundingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: 16,
    marginBottom: 32,
  },
  surroundingStation: {
    fontSize: 14,
    maxWidth: '45%',
  },
  surroundingStationAlert: {
    color: '#ffb74d',
    fontWeight: 'bold',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
  },
  errorIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  errorText: {
    color: '#ef9a9a',
    fontSize: 16,
    textAlign: 'center',
    lineHeight: 26,
  },
  stationLabel: {
    fontSize: 14,
    letterSpacing: 3,
    marginBottom: 8,
  },
  stationName: {
    fontSize: 72,
    fontWeight: 'bold',
    letterSpacing: 2,
    textAlign: 'center',
  },
  stationNameKana: {
    fontSize: 20,
    marginTop: 4,
    letterSpacing: 6,
  },
  linesContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    marginTop: 20,
    gap: 8,
  },
  lineTag: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    fontSize: 12,
    borderWidth: 1,
  },
  distanceText: {
    fontSize: 14,
    marginTop: 24,
    letterSpacing: 1,
  },
  alertBox: {
    marginTop: 32,
    borderRadius: 12,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  alertText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: 'bold',
    letterSpacing: 2,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  modalContainer: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 16,
    maxHeight: '85%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  modalClose: {
    fontSize: 14,
  },
  clearButton: {
    marginHorizontal: 20,
    marginBottom: 12,
    padding: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  clearButtonText: {
    color: '#ef9a9a',
    fontSize: 13,
  },
  searchInput: {
    marginHorizontal: 20,
    marginBottom: 8,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    borderWidth: 1,
  },
  stationItem: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  stationItemName: {
    fontSize: 15,
  },
  stationItemLine: {
    fontSize: 12,
  },
});
