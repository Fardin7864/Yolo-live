import React from 'react';
import { View, Text, Modal, FlatList, TouchableOpacity, StyleSheet } from 'react-native';

const countries = [
  { name: 'Bangladesh', code: '+880', flag: '🇧🇩' },
  { name: 'Saudi Arabia', code: '+966', flag: '🇸🇦' },
  { name: 'UAE (Dubai)', code: '+971', flag: '🇦🇪' },
  { name: 'Malaysia', code: '+60', flag: '🇲🇾' },
  { name: 'Qatar', code: '+974', flag: '🇶🇦' },
  { name: 'Oman', code: '+968', flag: '🇴🇲' },
];

const CountryModal = ({ visible, onClose, onSelect }) => {
  return (
    <Modal visible={visible} animationType="slide" transparent={true}>
      <View style={styles.overlay}>
        <View style={styles.modal}>
          <View style={styles.headerRow}>
            <Text style={styles.headerText}>Select Country</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.closeBtn}>✕</Text>
            </TouchableOpacity>
          </View>
          
          <FlatList
            data={countries}
            keyExtractor={(item) => item.code}
            renderItem={({ item }) => (
              <TouchableOpacity 
                style={styles.countryRow}
                onPress={() => {
                  onSelect(item);
                  onClose();
                }}
              >
                <Text style={styles.flag}>{item.flag}</Text>
                <Text style={styles.countryName}>{item.name}</Text>
                <Text style={styles.countryCode}>{item.code}</Text>
              </TouchableOpacity>
            )}
          />
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  modal: {
    backgroundColor: '#251B45',
    height: '50%',
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    padding: 24,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  headerText: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: 'bold',
  },
  closeBtn: {
    color: '#FFFFFF',
    fontSize: 20,
  },
  countryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  flag: {
    fontSize: 24,
    marginRight: 16,
  },
  countryName: {
    color: '#FFFFFF',
    fontSize: 18,
    flex: 1,
  },
  countryCode: {
    color: '#9CA3AF',
    fontWeight: 'bold',
  },
});

export default CountryModal;
