'use client'

import { useState } from 'react'
import { Save, Eye, EyeOff, Key, Shield, Bell, Database, Users, Building } from 'lucide-react'

interface Organization {
  id: string
  name: string
  secret_key: string
  subscription_status: string
  created_at: string
  settings: any
}

interface SettingsProps {
  organizations: Organization[]
  onUpdateOrganization: (id: string, data: any) => Promise<void>
  onRegenerateSecretKey: (id: string) => Promise<void>
}

export default function Settings({ organizations, onUpdateOrganization, onRegenerateSecretKey }: SettingsProps) {
  const [activeTab, setActiveTab] = useState('general')
  const [showSecretKeys, setShowSecretKeys] = useState<Record<string, boolean>>({})
  const [updating, setUpdating] = useState(false)
  const [regenerating, setRegenerating] = useState<string | null>(null)

  const [generalSettings, setGeneralSettings] = useState({
    companyName: '',
    timezone: 'UTC',
    dateFormat: 'MM/DD/YYYY',
    timeFormat: '12h',
    language: 'en'
  })

  const [securitySettings, setSecuritySettings] = useState({
    sessionTimeout: 30,
    requireMFA: false,
    passwordMinLength: 8,
    passwordComplexity: 'medium',
    loginAttempts: 5,
    lockoutDuration: 15
  })

  const [notificationSettings, setNotificationSettings] = useState({
    emailNotifications: true,
    slackNotifications: false,
    dailyReports: true,
    weeklyReports: true,
    monthlyReports: true,
    idleAlerts: true,
    productivityAlerts: true
  })

  const [dataSettings, setDataSettings] = useState({
    dataRetention: 90,
    autoBackup: true,
    backupFrequency: 'daily',
    exportFormat: 'csv',
    anonymizeData: false
  })

  const handleSaveGeneralSettings = async () => {
    setUpdating(true)
    try {
      // Save general settings logic here
      console.log('Saving general settings:', generalSettings)
    } catch (error) {
      console.error('Failed to save general settings:', error)
    } finally {
      setUpdating(false)
    }
  }

  const handleSaveSecuritySettings = async () => {
    setUpdating(true)
    try {
      // Save security settings logic here
      console.log('Saving security settings:', securitySettings)
    } catch (error) {
      console.error('Failed to save security settings:', error)
    } finally {
      setUpdating(false)
    }
  }

  const handleSaveNotificationSettings = async () => {
    setUpdating(true)
    try {
      // Save notification settings logic here
      console.log('Saving notification settings:', notificationSettings)
    } catch (error) {
      console.error('Failed to save notification settings:', error)
    } finally {
      setUpdating(false)
    }
  }

  const handleSaveDataSettings = async () => {
    setUpdating(true)
    try {
      // Save data settings logic here
      console.log('Saving data settings:', dataSettings)
    } catch (error) {
      console.error('Failed to save data settings:', error)
    } finally {
      setUpdating(false)
    }
  }

  const handleRegenerateSecretKey = async (orgId: string) => {
    setRegenerating(orgId)
    try {
      await onRegenerateSecretKey(orgId)
    } catch (error) {
      console.error('Failed to regenerate secret key:', error)
    } finally {
      setRegenerating(null)
    }
  }

  const toggleSecretKey = (orgId: string) => {
    setShowSecretKeys(prev => ({
      ...prev,
      [orgId]: !prev[orgId]
    }))
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  const tabs = [
    { id: 'general', name: 'General', icon: Building },
    { id: 'security', name: 'Security', icon: Shield },
    { id: 'notifications', name: 'Notifications', icon: Bell },
    { id: 'data', name: 'Data & Privacy', icon: Database },
    { id: 'organizations', name: 'Organizations', icon: Users }
  ]

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-medium text-gray-900">Settings</h2>
        <p className="text-sm text-gray-600">Manage your system preferences and configurations</p>
      </div>

      {/* Tab Navigation */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="-mb-px flex space-x-8">
          {tabs.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`py-2 px-1 border-b-2 font-medium text-sm flex items-center ${
                  activeTab === tab.id
                    ? 'border-indigo-500 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                <Icon className="h-4 w-4 mr-2" />
                {tab.name}
              </button>
            )
          })}
        </nav>
      </div>

      {/* General Settings */}
      {activeTab === 'general' && (
        <div className="space-y-6">
          <div className="bg-white shadow rounded-lg p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">General Settings</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Company Name
                </label>
                <input
                  type="text"
                  value={generalSettings.companyName}
                  onChange={(e) => setGeneralSettings({ ...generalSettings, companyName: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                  placeholder="Enter company name"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Timezone
                </label>
                <select
                  value={generalSettings.timezone}
                  onChange={(e) => setGeneralSettings({ ...generalSettings, timezone: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                >
                  <option value="UTC">UTC</option>
                  <option value="America/New_York">Eastern Time</option>
                  <option value="America/Chicago">Central Time</option>
                  <option value="America/Denver">Mountain Time</option>
                  <option value="America/Los_Angeles">Pacific Time</option>
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Date Format
                </label>
                <select
                  value={generalSettings.dateFormat}
                  onChange={(e) => setGeneralSettings({ ...generalSettings, dateFormat: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                >
                  <option value="MM/DD/YYYY">MM/DD/YYYY</option>
                  <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                  <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Time Format
                </label>
                <select
                  value={generalSettings.timeFormat}
                  onChange={(e) => setGeneralSettings({ ...generalSettings, timeFormat: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                >
                  <option value="12h">12-hour</option>
                  <option value="24h">24-hour</option>
                </select>
              </div>
            </div>
            
            <div className="mt-6 flex justify-end">
              <button
                onClick={handleSaveGeneralSettings}
                disabled={updating}
                className="flex items-center px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
              >
                <Save className="h-4 w-4 mr-2" />
                {updating ? 'Saving...' : 'Save Settings'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Security Settings */}
      {activeTab === 'security' && (
        <div className="space-y-6">
          <div className="bg-white shadow rounded-lg p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Security Settings</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Session Timeout (minutes)
                </label>
                <input
                  type="number"
                  value={securitySettings.sessionTimeout}
                  onChange={(e) => setSecuritySettings({ ...securitySettings, sessionTimeout: parseInt(e.target.value) })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                  min="5"
                  max="480"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Password Minimum Length
                </label>
                <input
                  type="number"
                  value={securitySettings.passwordMinLength}
                  onChange={(e) => setSecuritySettings({ ...securitySettings, passwordMinLength: parseInt(e.target.value) })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                  min="6"
                  max="20"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Password Complexity
                </label>
                <select
                  value={securitySettings.passwordComplexity}
                  onChange={(e) => setSecuritySettings({ ...securitySettings, passwordComplexity: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                >
                  <option value="low">Low (letters only)</option>
                  <option value="medium">Medium (letters + numbers)</option>
                  <option value="high">High (letters + numbers + symbols)</option>
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Login Attempts Before Lockout
                </label>
                <input
                  type="number"
                  value={securitySettings.loginAttempts}
                  onChange={(e) => setSecuritySettings({ ...securitySettings, loginAttempts: parseInt(e.target.value) })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                  min="3"
                  max="10"
                />
              </div>
            </div>
            
            <div className="mt-6 space-y-4">
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="requireMFA"
                  checked={securitySettings.requireMFA}
                  onChange={(e) => setSecuritySettings({ ...securitySettings, requireMFA: e.target.checked })}
                  className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                />
                <label htmlFor="requireMFA" className="ml-2 block text-sm text-gray-900">
                  Require Multi-Factor Authentication
                </label>
              </div>
            </div>
            
            <div className="mt-6 flex justify-end">
              <button
                onClick={handleSaveSecuritySettings}
                disabled={updating}
                className="flex items-center px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
              >
                <Save className="h-4 w-4 mr-2" />
                {updating ? 'Saving...' : 'Save Security Settings'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Notification Settings */}
      {activeTab === 'notifications' && (
        <div className="space-y-6">
          <div className="bg-white shadow rounded-lg p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Notification Settings</h3>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-medium text-gray-900">Email Notifications</h4>
                  <p className="text-sm text-gray-500">Receive notifications via email</p>
                </div>
                <input
                  type="checkbox"
                  checked={notificationSettings.emailNotifications}
                  onChange={(e) => setNotificationSettings({ ...notificationSettings, emailNotifications: e.target.checked })}
                  className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                />
              </div>
              
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-medium text-gray-900">Slack Notifications</h4>
                  <p className="text-sm text-gray-500">Receive notifications via Slack</p>
                </div>
                <input
                  type="checkbox"
                  checked={notificationSettings.slackNotifications}
                  onChange={(e) => setNotificationSettings({ ...notificationSettings, slackNotifications: e.target.checked })}
                  className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                />
              </div>
              
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-medium text-gray-900">Daily Reports</h4>
                  <p className="text-sm text-gray-500">Receive daily productivity reports</p>
                </div>
                <input
                  type="checkbox"
                  checked={notificationSettings.dailyReports}
                  onChange={(e) => setNotificationSettings({ ...notificationSettings, dailyReports: e.target.checked })}
                  className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                />
              </div>
              
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-medium text-gray-900">Weekly Reports</h4>
                  <p className="text-sm text-gray-500">Receive weekly productivity reports</p>
                </div>
                <input
                  type="checkbox"
                  checked={notificationSettings.weeklyReports}
                  onChange={(e) => setNotificationSettings({ ...notificationSettings, weeklyReports: e.target.checked })}
                  className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                />
              </div>
              
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-medium text-gray-900">Idle Alerts</h4>
                  <p className="text-sm text-gray-500">Get notified when employees are idle</p>
                </div>
                <input
                  type="checkbox"
                  checked={notificationSettings.idleAlerts}
                  onChange={(e) => setNotificationSettings({ ...notificationSettings, idleAlerts: e.target.checked })}
                  className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                />
              </div>
              
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-medium text-gray-900">Productivity Alerts</h4>
                  <p className="text-sm text-gray-500">Get notified about productivity changes</p>
                </div>
                <input
                  type="checkbox"
                  checked={notificationSettings.productivityAlerts}
                  onChange={(e) => setNotificationSettings({ ...notificationSettings, productivityAlerts: e.target.checked })}
                  className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                />
              </div>
            </div>
            
            <div className="mt-6 flex justify-end">
              <button
                onClick={handleSaveNotificationSettings}
                disabled={updating}
                className="flex items-center px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
              >
                <Save className="h-4 w-4 mr-2" />
                {updating ? 'Saving...' : 'Save Notification Settings'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Data & Privacy Settings */}
      {activeTab === 'data' && (
        <div className="space-y-6">
          <div className="bg-white shadow rounded-lg p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Data & Privacy Settings</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Data Retention Period (days)
                </label>
                <input
                  type="number"
                  value={dataSettings.dataRetention}
                  onChange={(e) => setDataSettings({ ...dataSettings, dataRetention: parseInt(e.target.value) })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                  min="30"
                  max="365"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Backup Frequency
                </label>
                <select
                  value={dataSettings.backupFrequency}
                  onChange={(e) => setDataSettings({ ...dataSettings, backupFrequency: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Export Format
                </label>
                <select
                  value={dataSettings.exportFormat}
                  onChange={(e) => setDataSettings({ ...dataSettings, exportFormat: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                >
                  <option value="csv">CSV</option>
                  <option value="json">JSON</option>
                  <option value="xlsx">Excel</option>
                </select>
              </div>
            </div>
            
            <div className="mt-6 space-y-4">
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="autoBackup"
                  checked={dataSettings.autoBackup}
                  onChange={(e) => setDataSettings({ ...dataSettings, autoBackup: e.target.checked })}
                  className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                />
                <label htmlFor="autoBackup" className="ml-2 block text-sm text-gray-900">
                  Enable Automatic Backups
                </label>
              </div>
              
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="anonymizeData"
                  checked={dataSettings.anonymizeData}
                  onChange={(e) => setDataSettings({ ...dataSettings, anonymizeData: e.target.checked })}
                  className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                />
                <label htmlFor="anonymizeData" className="ml-2 block text-sm text-gray-900">
                  Anonymize Data in Exports
                </label>
              </div>
            </div>
            
            <div className="mt-6 flex justify-end">
              <button
                onClick={handleSaveDataSettings}
                disabled={updating}
                className="flex items-center px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
              >
                <Save className="h-4 w-4 mr-2" />
                {updating ? 'Saving...' : 'Save Data Settings'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Organization Management */}
      {activeTab === 'organizations' && (
        <div className="space-y-6">
          <div className="bg-white shadow rounded-lg p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Organization Management</h3>
            <div className="space-y-4">
              {organizations.map((org) => (
                <div key={org.id} className="border border-gray-200 rounded-lg p-4">
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <h4 className="text-lg font-medium text-gray-900">{org.name}</h4>
                      <p className="text-sm text-gray-500">Created: {new Date(org.created_at).toLocaleDateString()}</p>
                      <p className="text-sm text-gray-500">Status: {org.subscription_status}</p>
                    </div>
                    <div className="flex space-x-2">
                      <button
                        onClick={() => toggleSecretKey(org.id)}
                        className="flex items-center px-3 py-1 text-sm text-gray-600 hover:text-gray-800"
                      >
                        {showSecretKeys[org.id] ? <EyeOff className="h-4 w-4 mr-1" /> : <Eye className="h-4 w-4 mr-1" />}
                        {showSecretKeys[org.id] ? 'Hide' : 'Show'} Key
                      </button>
                      <button
                        onClick={() => copyToClipboard(org.secret_key)}
                        className="flex items-center px-3 py-1 text-sm text-gray-600 hover:text-gray-800"
                      >
                        <Key className="h-4 w-4 mr-1" />
                        Copy
                      </button>
                      <button
                        onClick={() => handleRegenerateSecretKey(org.id)}
                        disabled={regenerating === org.id}
                        className="flex items-center px-3 py-1 text-sm text-red-600 hover:text-red-800 disabled:opacity-50"
                      >
                        <Key className="h-4 w-4 mr-1" />
                        {regenerating === org.id ? 'Regenerating...' : 'Regenerate'}
                      </button>
                    </div>
                  </div>
                  
                  {showSecretKeys[org.id] && (
                    <div className="mt-3 p-3 bg-gray-50 rounded-md">
                      <div className="flex items-center justify-between">
                        <code className="text-sm font-mono text-gray-800 break-all">
                          {org.secret_key}
                        </code>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
} 