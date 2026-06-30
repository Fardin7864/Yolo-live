import React from 'react';
import { View, TextInput, Text, StyleSheet } from 'react-native';

const InputField = ({ label, placeholder, value, onChangeText, secureTextEntry, keyboardType }) => {
  return (
    <View style={styles.container}>
      {label && <Text style={styles.label}>{label}</Text>}
      <View style={styles.inputWrapper}>
        <TextInput
          placeholder={placeholder}
          placeholderTextColor="#A0A0A0"
          value={value}
          onChangeText={onChangeText}
          secureTextEntry={secureTextEntry}
          keyboardType={keyboardType}
          style={styles.input}
        />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginBottom: 16,
  },
  label: {
    color: '#FFFFFF',
    marginBottom: 8,
    fontSize: 14,
    marginLeft: 8,
    fontWeight: '500',
  },
  inputWrapper: {
    backgroundColor: '#251B45',
    height: 56,
    borderRadius: 28,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#3E2D6D',
  },
  input: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 16,
  },
});

export default InputField;
