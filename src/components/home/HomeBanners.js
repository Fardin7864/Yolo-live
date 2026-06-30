/**
 * HomeBanners
 * ===========
 * Auto-rotating banner carousel that sits above the live grid on the
 * home tab. Reads from the admin-managed `home_banners` table via
 * GlobalStateContext, so an admin swap propagates to every device
 * within ~1 second via the realtime subscription.
 *
 * Behaviour:
 *   - Auto-advances every 4 seconds while idle
 *   - User swipe pauses the auto-advance for 8 seconds (so a tap
 *     to read details doesn't get yanked away)
 *   - Pagination dots below — current dot wider + brighter
 *   - Tap → opens banner.link_url (deep-link or external URL)
 *   - Hides itself completely when there are zero active banners
 *
 * Responsive sizing:
 *   The previous version used `Dimensions.get('window').width` baked
 *   in at module load — that ignored:
 *     1. The padding on the parent FlatList contentContainerStyle
 *        (banner overflowed by ~16px on one edge), and
 *     2. Orientation / split-screen / foldable width changes.
 *
 *   We now use onLayout to measure the actual width the parent gives
 *   us, then derive the banner dimensions from that. The component
 *   waits for the first onLayout before rendering anything that
 *   depends on width — one extra frame for a guaranteed-correct fit
 *   on every device, every orientation.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Image, TouchableOpacity, FlatList, StyleSheet, Linking } from 'react-native';

const ASPECT          = 2.16;     // 1080:500 — matches the admin-upload spec
const MAX_HEIGHT      = 220;      // Tablets / foldables stay sensible
const AUTO_ADVANCE_MS = 4000;
const RESUME_AFTER_TOUCH = 8000;

export default function HomeBanners({ banners = [] }) {
  // Defensive filter so an upstream bug feeding us inactive / broken
  // rows can't render a blank tile in the carousel.
  const active = useMemo(
    () => (banners || []).filter((b) => b?.is_active !== false && b?.image_url),
    [banners]
  );

  const [index, setIndex]               = useState(0);
  const [containerWidth, setWidth]      = useState(0);   // Set by onLayout
  const listRef                         = useRef(null);
  const pausedRef                       = useRef(false);
  const resumeTimerRef                  = useRef(null);

  const bannerHeight = containerWidth > 0
    ? Math.min(Math.round(containerWidth / ASPECT), MAX_HEIGHT)
    : 0;

  // Auto-advance loop — only when we have width + > 1 banner.
  useEffect(() => {
    if (active.length <= 1 || containerWidth === 0) return undefined;
    const t = setInterval(() => {
      if (pausedRef.current) return;
      setIndex((cur) => {
        const next = (cur + 1) % active.length;
        try {
          listRef.current?.scrollToOffset({ offset: next * containerWidth, animated: true });
        } catch (_) {}
        return next;
      });
    }, AUTO_ADVANCE_MS);
    return () => clearInterval(t);
  }, [active.length, containerWidth]);

  // Re-snap to the current index when the container resizes (rotate,
  // split-screen). Without this, a width change leaves the FlatList
  // mid-scroll between two banners.
  useEffect(() => {
    if (containerWidth === 0) return;
    try {
      listRef.current?.scrollToOffset({ offset: index * containerWidth, animated: false });
    } catch (_) {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerWidth]);

  const onMomentumEnd = (e) => {
    if (containerWidth === 0) return;
    const nextIndex = Math.round(e.nativeEvent.contentOffset.x / containerWidth);
    if (nextIndex !== index) setIndex(nextIndex);
  };

  const onTouchStart = () => {
    pausedRef.current = true;
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = setTimeout(() => { pausedRef.current = false; }, RESUME_AFTER_TOUCH);
  };

  useEffect(() => () => {
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
  }, []);

  const openBanner = (banner) => {
    if (!banner?.link_url) return;
    Linking.openURL(banner.link_url).catch(() => { /* invalid URL — silent */ });
  };

  if (active.length === 0) return null;

  return (
    <View
      style={styles.wrap}
      onLayout={(e) => {
        const w = Math.round(e.nativeEvent.layout.width);
        // Only update when it actually changes — avoids a re-render
        // loop on devices that fire onLayout on every render.
        if (w > 0 && w !== containerWidth) setWidth(w);
      }}
      onTouchStart={onTouchStart}
    >
      {containerWidth > 0 && (
        <View style={{ width: containerWidth, height: bannerHeight, borderRadius: 12, overflow: 'hidden' }}>
          <FlatList
            ref={listRef}
            data={active}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            snapToInterval={containerWidth}
            decelerationRate="fast"
            keyExtractor={(item) => item.id}
            onMomentumScrollEnd={onMomentumEnd}
            // Help the virtualised list compute item offsets without
            // measurement passes — every banner has identical width.
            getItemLayout={(_, i) => ({
              length: containerWidth,
              offset: containerWidth * i,
              index:  i,
            })}
            renderItem={({ item }) => (
              <TouchableOpacity
                activeOpacity={0.9}
                disabled={!item.link_url}
                onPress={() => openBanner(item)}
                style={{ width: containerWidth, height: bannerHeight }}
              >
                <Image
                  source={{ uri: item.image_url }}
                  style={{ width: containerWidth, height: bannerHeight }}
                  resizeMode="cover"
                />
              </TouchableOpacity>
            )}
          />

          {active.length > 1 && (
            <View style={styles.dots} pointerEvents="none">
              {active.map((_, i) => (
                <View
                  key={i}
                  style={[styles.dot, i === index && styles.dotActive]}
                />
              ))}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    // No fixed width — parent layout decides. Banner snaps to whatever
    // it actually has to work with (e.g. FlatList content padding,
    // tablet split-view, foldable unfolded, etc.).
    // No bottom margin — the banner sits directly against the first
    // row of live cards. The cards have their own marginBottom (16) so
    // ROW spacing within the grid is preserved; only the
    // banner-to-cards gap is collapsed. Earlier passes used 10px and
    // 4px but the user wanted a visibly tighter join.
    marginBottom: 0,
  },
  dots: {
    position: 'absolute',
    bottom:   8,
    left:     0, right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
  },
  dot: {
    width:  6, height: 6,
    borderRadius: 3,
    marginHorizontal: 3,
    backgroundColor: 'rgba(255,255,255,0.4)',
  },
  dotActive: {
    width: 18,
    backgroundColor: '#FFFFFF',
  },
});
