import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { View, StyleSheet, Platform, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { BRAND } from '../../../src/theme/brand';

export default function TabLayout() {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const tabBarHorizontalMargin = width >= 600 ? 24 : 8;
  const tabBarHeight = 76 + Math.max(insets.bottom, 8);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: styles.transparentScene,
        tabBarStyle: [
          styles.tabBar,
          {
            left: tabBarHorizontalMargin,
            right: tabBarHorizontalMargin,
            bottom: 0,
            height: tabBarHeight,
            paddingBottom: Math.max(insets.bottom, 8),
          }
        ],
        tabBarActiveTintColor: '#B64CFF',
        tabBarInactiveTintColor: '#9694B4',
        tabBarShowLabel: true,
        tabBarLabelStyle: styles.tabLabel,
        // Critical: When using absolute position for tab bar, we must zero out the default safe area padding,
        // otherwise it squishes the icons on different devices.
        safeAreaInsets: { bottom: 0 }, 
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size, focused }) => (
            <View style={styles.iconContainer}>
              <Ionicons name={focused ? "home" : "home-outline"} size={25} color={color} />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: 'Explore',
          tabBarIcon: ({ color, size, focused }) => (
            <View style={styles.iconContainer}>
              <Ionicons name={focused ? "compass" : "compass-outline"} size={26} color={color} />
            </View>
          ),
        }}
      />
      
      {/* The Central "Go Live" Button */}
      <Tabs.Screen
        name="live"
        options={{
          title: '',
          tabBarIcon: () => (
            <View style={styles.liveButtonContainer}>
              <LinearGradient
                colors={['#F033DA', '#8E43FF', '#24BFFF']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.liveButton}
              >
                <Ionicons name="add" size={40} color="#FFFFFF" />
              </LinearGradient>
            </View>
          ),
        }}
      />

      <Tabs.Screen
        name="messages"
        options={{
          title: 'Messages',
          tabBarIcon: ({ color, size, focused }) => (
            <View style={styles.iconContainer}>
              <Ionicons name={focused ? "chatbubble" : "chatbubble-outline"} size={24} color={color} />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, size, focused }) => (
            <View style={styles.iconContainer}>
              <Ionicons name={focused ? "person" : "person-outline"} size={25} color={color} />
            </View>
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  transparentScene: { backgroundColor: 'transparent' },
  tabBar: {
    position: 'absolute',
    backgroundColor: 'rgba(9, 10, 39, 0.97)',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: 'rgba(159, 116, 255, 0.28)',
    elevation: 18,
    shadowColor: '#6E32EF',
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.28,
    shadowRadius: 18,
  },
  tabLabel: { fontSize: 10.5, fontWeight: '600', marginTop: -2 },
  iconContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    width: '100%',
  },
  liveButtonContainer: {
    top: -25,
    justifyContent: 'center',
    alignItems: 'center',
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#221050',
    padding: 5,
    borderWidth: 1.5,
    borderColor: '#DC5CFF',
    shadowColor: '#D52DFF',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.7,
    shadowRadius: 16,
    elevation: 14,
  },
  liveButton: {
    width: '100%',
    height: '100%',
    borderRadius: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
