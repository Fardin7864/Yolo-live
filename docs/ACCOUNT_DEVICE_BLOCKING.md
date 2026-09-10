# Account and Device Blocking

## Access modes

### Temporary account block

- Identifies the account by its Supabase Auth user ID and email.
- Sets `profiles.is_banned` and `profiles.status`.
- Synchronizes the block to `auth.users.banned_until`, preventing sign-in and token refresh.
- Preserves the profile, wallet, content, and history.
- Unblock clears both profile and Auth restrictions.

### Device block

- Blocks the selected registered installation for every account.
- Also blocks the selected user's account ID/email in the same transaction.
- Uses a server-hashed Android SSAID (or iOS identifier-for-vendor) as the primary fingerprint.
- Keeps the generated installation ID, model, OS, app version, last IP, and last-seen time for audit.
- IP is not the blocking key because carrier IPs change and shared Wi-Fi gives multiple people one public IP.
- Admins can block one device, all devices linked to a user, or remove an existing device block.
- Unblocking a device also clears the account and Auth restriction created by
  that device action, restoring access without a second admin operation.

## Runtime flow

1. `DeviceAccessGate` runs before navigation, maintenance, update, and remote splash content.
2. `deviceIdentity` obtains the platform identifier and a persisted installation ID without a dangerous permission.
3. The app invokes the public `device-access` Edge Function over HTTPS.
4. The function hashes identifiers using the server-only `DEVICE_ID_PEPPER` secret.
5. Device metadata and authenticated user linkage are updated with the service role.
6. The function checks account and device restrictions and returns a narrow allow/deny response.
7. Profile Realtime immediately shows the block screen and unmounts live/game/action screens.
8. The check repeats after authentication, on foreground, and every 30 seconds while active as recovery if Realtime was missed.

## Admin flow

Open **User Management**, find a user, and select the ban icon.

- **Temporary Account Block** shows the Auth email and current account status.
- **Permanent Device Block** lists every device observed after this app version was installed and opened.
- Actions are enforced by security-definer RPCs and written to `admin_audit_log`.

## Platform limits

No mobile identifier is physically permanent. Android can change SSAID after a factory reset, app-signing identity change, or some multi-user changes. iOS can change identifier-for-vendor after all apps from the vendor are removed. The implementation uses the strongest policy-compliant, permissionless app identifier available and does not use invasive hardware identifiers.

Code cannot run at APK installation time. Registration happens on the first app launch. Android also does not allow an app to request every permission at install time; permissions must be minimal and requested in context. Device registration requires no new dangerous permission.
