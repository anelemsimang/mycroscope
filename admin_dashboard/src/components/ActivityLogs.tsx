'use client'

import { useState } from 'react'
import { Download, Filter, Search, Calendar, User, Building } from 'lucide-react'

interface ActivityLog {
  id: string
  employee_id: string
  organization_id: string
  activity_type: string
  description: string
  timestamp: string
  metadata: any
  employees?: { name: string; email: string }
  organizations?: { name: string }
}

interface ActivityLogsProps {
  activityLogs: ActivityLog[]
  employees: any[]
  organizations: any[]
}

export default function ActivityLogs({ activityLogs, employees, organizations }: ActivityLogsProps) {
  const [filters, setFilters] = useState({
    employee: '',
    organization: '',
    activityType: '',
    dateFrom: '',
    dateTo: '',
    search: ''
  })

  const getActivityIcon = (type: string) => {
    switch (type) {
      case 'login': return '🔐'
      case 'logout': return '🚪'
      case 'project_switch': return '🔄'
      case 'app_launch': return '🚀'
      case 'file_access': return '📁'
      case 'web_visit': return '🌐'
      case 'idle_start': return '😴'
      case 'idle_end': return '👁️'
      default: return '📝'
    }
  }

  const getActivityColor = (type: string) => {
    switch (type) {
      case 'login': return 'bg-green-100 text-green-800'
      case 'logout': return 'bg-red-100 text-red-800'
      case 'project_switch': return 'bg-blue-100 text-blue-800'
      case 'app_launch': return 'bg-purple-100 text-purple-800'
      case 'file_access': return 'bg-yellow-100 text-yellow-800'
      case 'web_visit': return 'bg-indigo-100 text-indigo-800'
      case 'idle_start': return 'bg-gray-100 text-gray-800'
      case 'idle_end': return 'bg-orange-100 text-orange-800'
      default: return 'bg-gray-100 text-gray-800'
    }
  }

  const filteredLogs = activityLogs.filter(log => {
    if (filters.employee && log.employee_id !== filters.employee) return false
    if (filters.organization && log.organization_id !== filters.organization) return false
    if (filters.activityType && log.activity_type !== filters.activityType) return false
    if (filters.search) {
      const searchLower = filters.search.toLowerCase()
      const employee = employees.find(emp => emp.id === log.employee_id)
      const organization = organizations.find(org => org.id === log.organization_id)
      if (!employee?.name.toLowerCase().includes(searchLower) && 
          !organization?.name.toLowerCase().includes(searchLower) &&
          !log.description.toLowerCase().includes(searchLower)) return false
    }
    if (filters.dateFrom && new Date(log.timestamp) < new Date(filters.dateFrom)) return false
    if (filters.dateTo && new Date(log.timestamp) > new Date(filters.dateTo)) return false
    return true
  })

  const exportActivityLogs = () => {
    const csvContent = [
      ['Timestamp', 'Employee', 'Organization', 'Activity Type', 'Description', 'Metadata'],
      ...filteredLogs.map(log => {
        const employee = employees.find(emp => emp.id === log.employee_id)
        const organization = organizations.find(org => org.id === log.organization_id)
        return [
          new Date(log.timestamp).toLocaleString(),
          employee?.name || 'Unknown',
          organization?.name || 'Unknown',
          log.activity_type,
          log.description || '',
          JSON.stringify(log.metadata || {})
        ]
      })
    ].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n')

    const blob = new Blob([csvContent], { type: 'text/csv' })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `activity_logs_${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    window.URL.revokeObjectURL(url)
  }

  const clearFilters = () => {
    setFilters({
      employee: '',
      organization: '',
      activityType: '',
      dateFrom: '',
      dateTo: '',
      search: ''
    })
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-lg font-medium text-gray-900">Activity Logs</h2>
        <button 
          onClick={exportActivityLogs}
          className="flex items-center px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700"
        >
          <Download className="h-4 w-4 mr-2" />
          Export Logs
        </button>
      </div>

      {/* Advanced Filters */}
      <div className="mb-6 bg-gray-50 p-4 rounded-lg">
        <div className="flex items-center mb-4">
          <Filter className="h-4 w-4 mr-2" />
          <h3 className="text-sm font-medium text-gray-700">Filters</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Search</label>
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-gray-400" />
              <input
                placeholder="Search logs..."
                value={filters.search}
                onChange={(e) => setFilters({ ...filters, search: e.target.value })}
                className="pl-8 pr-3 py-2 border border-gray-300 rounded-md text-sm w-full"
              />
            </div>
          </div>
          
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Employee</label>
            <select
              value={filters.employee}
              onChange={(e) => setFilters({ ...filters, employee: e.target.value })}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm w-full"
            >
              <option value="">All Employees</option>
              {employees.map(emp => (
                <option key={emp.id} value={emp.id}>{emp.name}</option>
              ))}
            </select>
          </div>
          
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Organization</label>
            <select
              value={filters.organization}
              onChange={(e) => setFilters({ ...filters, organization: e.target.value })}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm w-full"
            >
              <option value="">All Organizations</option>
              {organizations.map(org => (
                <option key={org.id} value={org.id}>{org.name}</option>
              ))}
            </select>
          </div>
          
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Activity Type</label>
            <select
              value={filters.activityType}
              onChange={(e) => setFilters({ ...filters, activityType: e.target.value })}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm w-full"
            >
              <option value="">All Activities</option>
              <option value="login">Login</option>
              <option value="logout">Logout</option>
              <option value="project_switch">Project Switch</option>
              <option value="app_launch">App Launch</option>
              <option value="file_access">File Access</option>
              <option value="web_visit">Web Visit</option>
              <option value="idle_start">Idle Start</option>
              <option value="idle_end">Idle End</option>
            </select>
          </div>
          
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">From Date</label>
            <div className="relative">
              <Calendar className="absolute left-2 top-2.5 h-4 w-4 text-gray-400" />
              <input
                type="date"
                value={filters.dateFrom}
                onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })}
                className="pl-8 pr-3 py-2 border border-gray-300 rounded-md text-sm w-full"
              />
            </div>
          </div>
          
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">To Date</label>
            <div className="relative">
              <Calendar className="absolute left-2 top-2.5 h-4 w-4 text-gray-400" />
              <input
                type="date"
                value={filters.dateTo}
                onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })}
                className="pl-8 pr-3 py-2 border border-gray-300 rounded-md text-sm w-full"
              />
            </div>
          </div>
        </div>
        
        <div className="mt-4 flex justify-between items-center">
          <span className="text-sm text-gray-600">
            Showing {filteredLogs.length} of {activityLogs.length} logs
          </span>
          <button
            onClick={clearFilters}
            className="text-sm text-gray-600 hover:text-gray-800"
          >
            Clear All Filters
          </button>
        </div>
      </div>

      {/* Activity Logs Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Timestamp
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Employee
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Organization
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Activity
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Description
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Details
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {filteredLogs.map((log) => {
              const employee = employees.find(emp => emp.id === log.employee_id)
              const organization = organizations.find(org => org.id === log.organization_id)
              
              return (
                <tr key={log.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    <div>
                      <div className="font-medium">
                        {new Date(log.timestamp).toLocaleDateString()}
                      </div>
                      <div className="text-gray-500">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center">
                      <User className="h-4 w-4 text-gray-400 mr-2" />
                      <div>
                        <div className="text-sm font-medium text-gray-900">
                          {employee?.name || 'Unknown'}
                        </div>
                        <div className="text-sm text-gray-500">
                          {employee?.email || 'No email'}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center">
                      <Building className="h-4 w-4 text-gray-400 mr-2" />
                      <div className="text-sm text-gray-900">
                        {organization?.name || 'Unknown'}
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center">
                      <span className="text-lg mr-2">{getActivityIcon(log.activity_type)}</span>
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getActivityColor(log.activity_type)}`}>
                        {log.activity_type.replace('_', ' ')}
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-900 max-w-xs truncate">
                    {log.description || '-'}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {log.metadata ? (
                      <details className="cursor-pointer">
                        <summary className="text-indigo-600 hover:text-indigo-800">
                          View Details
                        </summary>
                        <pre className="mt-2 text-xs bg-gray-100 p-2 rounded overflow-auto max-w-xs">
                          {JSON.stringify(log.metadata, null, 2)}
                        </pre>
                      </details>
                    ) : (
                      '-'
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {filteredLogs.length === 0 && (
        <div className="text-center py-12">
          <div className="text-gray-400 text-6xl mb-4">📝</div>
          <h3 className="text-lg font-medium text-gray-900 mb-2">No activity logs found</h3>
          <p className="text-gray-500">Try adjusting your filters or check back later for new activity.</p>
        </div>
      )}
    </div>
  )
} 