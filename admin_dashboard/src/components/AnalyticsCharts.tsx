'use client'

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, PieChart, Cell, Pie, AreaChart, Area } from 'recharts'

interface AnalyticsData {
  activityByDay: Array<{ date: string; count: number }>
  organizationStats: Array<{ name: string; employees: number; activity: number }>
  statusDistribution: Array<{ status: string; count: number }>
  totalProductiveTime: number
  topApps: Array<{ app: string; time: number }>
  topDomains: Array<{ domain: string; time: number }>
  averageSessionTime: number
  productivityScore: number
  activeUsers: number
}

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884D8', '#82CA9D', '#FFC658', '#FF7300']

export default function AnalyticsCharts({ data }: { data: AnalyticsData }) {
  return (
    <div className="space-y-8">
      {/* Enhanced Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-white p-6 rounded-lg shadow border-l-4 border-blue-500">
          <h3 className="text-sm font-medium text-gray-600">Total Productive Time</h3>
          <p className="text-2xl font-bold text-gray-900">{data.totalProductiveTime}h</p>
          <p className="text-xs text-gray-500">Last 30 days</p>
        </div>
        
        <div className="bg-white p-6 rounded-lg shadow border-l-4 border-green-500">
          <h3 className="text-sm font-medium text-gray-600">Productivity Score</h3>
          <p className="text-2xl font-bold text-gray-900">{data.productivityScore}%</p>
          <p className="text-xs text-gray-500">App vs Web ratio</p>
        </div>
        
        <div className="bg-white p-6 rounded-lg shadow border-l-4 border-purple-500">
          <h3 className="text-sm font-medium text-gray-600">Avg Session Time</h3>
          <p className="text-2xl font-bold text-gray-900">{data.averageSessionTime}m</p>
          <p className="text-xs text-gray-500">Per activity</p>
        </div>
        
        <div className="bg-white p-6 rounded-lg shadow border-l-4 border-orange-500">
          <h3 className="text-sm font-medium text-gray-600">Active Users</h3>
          <p className="text-2xl font-bold text-gray-900">{data.activeUsers}</p>
          <p className="text-xs text-gray-500">Last 30 days</p>
        </div>
      </div>

      {/* Activity and Status Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Activity Over Time</h3>
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={data.activityByDay}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Area type="monotone" dataKey="count" stroke="#3B82F6" fill="#3B82F6" fillOpacity={0.3} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Organization Status Distribution</h3>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={data.statusDistribution}
                cx="50%"
                cy="50%"
                labelLine={false}
                label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                outerRadius={80}
                fill="#8884d8"
                dataKey="count"
              >
                {data.statusDistribution.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Organization Performance */}
      <div className="bg-white p-6 rounded-lg shadow">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Organization Performance</h3>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={data.organizationStats}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" />
            <YAxis />
            <Tooltip />
            <Bar dataKey="employees" fill="#10B981" name="Employees" />
            <Bar dataKey="activity" fill="#3B82F6" name="Activity" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Top Apps and Domains */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Most Used Applications</h3>
          <div className="space-y-3">
            {data.topApps.length > 0 ? (
              data.topApps.map((app, index) => (
                <div key={app.app} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-center">
                    <span className="w-6 h-6 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center text-xs font-medium mr-3">
                      {index + 1}
                    </span>
                    <span className="font-medium text-gray-900">{app.app}</span>
                  </div>
                  <span className="text-sm text-gray-600">{app.time}m</span>
                </div>
              ))
            ) : (
              <p className="text-gray-500 text-center py-4">No app usage data available</p>
            )}
          </div>
        </div>

        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Most Visited Websites</h3>
          <div className="space-y-3">
            {data.topDomains.length > 0 ? (
              data.topDomains.map((domain, index) => (
                <div key={domain.domain} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-center">
                    <span className="w-6 h-6 bg-green-100 text-green-600 rounded-full flex items-center justify-center text-xs font-medium mr-3">
                      {index + 1}
                    </span>
                    <span className="font-medium text-gray-900">{domain.domain}</span>
                  </div>
                  <span className="text-sm text-gray-600">{domain.time}m</span>
                </div>
              ))
            ) : (
              <p className="text-gray-500 text-center py-4">No web activity data available</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
} 