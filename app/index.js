import { useEffect, useState } from 'react';
import { Redirect } from 'expo-router';
import { View } from 'react-native';
import LogoLoader from '../src/components/LogoLoader';
import { supabase } from '../src/api/supabase';

export default function Index() {
  // Decide where to land based on the current Supabase session so a logged-in
  // user doesn't flash the login screen on cold start.
  const [destination, setDestination] = useState(null); // null = checking

  useEffect(() => {
    let mounted = true;
    // Bounded session check. supabase.auth.getSession() normally returns
    // in <100ms from local AsyncStorage, but cold boots on slow Androids
    // (or pathological cases like Supabase's auth refresh hanging on a
    // captive-portal-style network) can push it well past a second.
    // We race against a generous 12s timeout so a logged-in user almost
    // never gets bounced to the login screen on cold start. If the race
    // is genuinely lost, we still send the user to login — but login.js
    // also re-checks the session and auto-forwards to main when found,
    // so a momentary timeout doesn't force a re-login.
    const sessionPromise = supabase.auth.getSession()
      .then(({ data }) => (data?.session ? '/main/(tabs)' : '/auth/login'))
      .catch(() => '/auth/login');
    const timeout = new Promise((resolve) => setTimeout(() => resolve('/auth/login'), 12000));

    Promise.race([sessionPromise, timeout]).then((dest) => {
      if (mounted) setDestination(dest);
    });

    return () => { mounted = false; };
  }, []);

  if (destination === null) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0E111E' }}>
        <LogoLoader size="medium" />
      </View>
    );
  }
  return <Redirect href={destination} />;
}