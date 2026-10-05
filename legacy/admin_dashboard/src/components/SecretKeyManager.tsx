'use client'

import { useState } from 'react'
import { Copy, Plus, CheckCircle, XCircle } from 'lucide-react'

interface AdminKey {
  id: string
  key_code: string
  organization_name: string
  is_active: boolean
  expires_at: string
  created_at: string
  usage_count: number
}

interface SecretKeyManagerProps {
  adminKeys: AdminKey[]
  onCreateKey: (keyData: { organization_name: string; expires_in_days: number }) => Promise<void>
  onToggleKey: (keyId: string, isActive: boolean) => Promise<void>
}

export default function SecretKeyManager({ adminKeys, onCreateKey, onToggleKey }: SecretKeyManagerProps) {
  const [showKeyModal, setShowKeyModal] = useState(false)
  const [newKey, setNewKey] = useState({ organization_name: '', expires_in_days: 30 })
  const [creating, setCreating] = useState(false)

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault()
    setCreating(true)
    try {
      await onCreateKey(newKey)
      setShowKeyModal(false)
      setNewKey({ organization_name: '', expires_in_days: 30 })
    } catch (error) {
      console.error('Failed to create key:', error)
    } finally {
      setCreating(false)
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-lg font-medium text-gray-900">Secret Key Management</h2>
        <button 
          onClick={() => setShowKeyModal(true)} 
          className="flex items-center px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700"
        >
          <Plus className="h-4 w-4 mr-2" />
          Generate New Key
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Key Code
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Organization
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Status
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Usage Count
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Expires
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {adminKeys.map((key) => (
              <tr key={key.id} className="hover:bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex items-center space-x-2">
                    <span className="text-sm font-mono bg-gray-100 px-2 py-1 rounded">
                      {key.key_code}
                    </span>
                    <button
                      onClick={() => copyToClipboard(key.key_code)}
                      className="text-gray-400 hover:text-gray-600"
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                  {key.organization_name}
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    key.is_active ? 'text-green-600 bg-green-100' : 'text-red-600 bg-red-100'
                  }`}>
                    {key.is_active ? <CheckCircle className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                    <span className="ml-1">{key.is_active ? 'Active' : 'Inactive'}</span>
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                  {key.usage_count}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                  {new Date(key.expires_at).toLocaleDateString()}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                  <button
                    onClick={() => onToggleKey(key.id, key.is_active)}
                    className={`${
                      key.is_active ? 'text-red-600 hover:text-red-900' : 'text-green-600 hover:text-green-900'
                    }`}
                  >
                    {key.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Key Generation Modal */}
      {showKeyModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-96 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <h3 className="text-lg font-medium text-gray-900 mb-4">Generate New Secret Key</h3>
              <form onSubmit={handleCreateKey}>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Organization Name</label>
                    <input
                      required
                      value={newKey.organization_name}
                      onChange={(e) => setNewKey({ ...newKey, organization_name: e.target.value })}
                      className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                      placeholder="Enter organization name"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Expires In (Days)</label>
                    <input
                      type="number"
                      min="1"
                      max="365"
                      value={newKey.expires_in_days}
                      onChange={(e) => setNewKey({ ...newKey, expires_in_days: parseInt(e.target.value) })}
                      className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                    />
                  </div>
                </div>
                <div className="flex justify-end space-x-3 mt-6">
                  <button
                    type="button"
                    onClick={() => setShowKeyModal(false)}
                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={creating}
                    className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {creating ? 'Generating...' : 'Generate Key'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  )
} 