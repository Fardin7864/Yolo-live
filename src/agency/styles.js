import { StyleSheet } from 'react-native';

export const commonStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0E111E' },
  header: { 
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', 
    paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#251B45' 
  },
  backBtn: { padding: 4 },
  headerTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold' },
  contentArea: { flex: 1, paddingHorizontal: 16 },
  
  // Tabs
  subTabContainer: {
    flexDirection: 'row',
    marginBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#1E1A34',
  },
  subTabItem: {
    paddingVertical: 12,
    marginRight: 24,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  subTabItemActive: {
    borderBottomColor: '#38BDF8',
  },
  subTabText: {
    color: '#9CA3AF',
    fontSize: 15,
    fontWeight: '600',
  },
  subTabTextActive: {
    color: '#38BDF8',
  },

  // Cards & Heroes
  heroCard: {
    borderRadius: 20,
    padding: 20,
    marginBottom: 24,
  },
  txRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1E1A34',
  },
  txIconBox: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  txDetails: { flex: 1 },
  txTitle: { color: '#FFFFFF', fontSize: 15, fontWeight: '600', marginBottom: 4 },
  txDate: { color: '#6B7280', fontSize: 12 },
  txAmount: { fontSize: 16, fontWeight: 'bold' },

  // Modals
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
    justifyContent: 'flex-end',
  },
  modalHandle: {
    width: 40,
    height: 5,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 3,
    alignSelf: 'center',
    marginBottom: 20,
  },
  modalTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 24,
    textAlign: 'center',
  },
  textInput: {
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: 12,
    color: '#FFFFFF',
    padding: 16,
    fontSize: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
});
