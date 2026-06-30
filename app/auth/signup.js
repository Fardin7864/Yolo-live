import React from 'react';
import { Redirect } from 'expo-router';

// Phone/password registration has been retired. Keeping this route as a
// redirect protects old bookmarks and links without exposing the old form.
export default function LegacySignupRedirect() {
  return <Redirect href="/auth/login" />;
}
