import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import LogoLoader from '../LogoLoader';
import { BRAND } from '../../theme/brand';

const GradientButton = ({ title, onPress, loading }) => {
  return (
    <TouchableOpacity 
      activeOpacity={0.8} 
      onPress={onPress} 
      disabled={loading}
      style={styles.button}
    >
      <LinearGradient
        colors={[BRAND.primary, BRAND.primaryAlt]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.gradient}
      >
        {loading ? (
          <LogoLoader size={36} />
        ) : (
          <Text style={styles.text}>{title}</Text>
        )}
      </LinearGradient>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  button: {
    width: '100%',
    height: 56,
    borderRadius: 28,
    overflow: 'hidden',
    marginTop: 16,
  },
  gradient: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  text: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 18,
  },
});

export default GradientButton;
