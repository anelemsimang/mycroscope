import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  RefreshControl,
} from 'react-native';
import { StackNavigationProp } from '@react-navigation/stack';
import { RouteProp, useRoute, useNavigation, useFocusEffect } from '@react-navigation/native';
import { RootStackParamList } from '../navigation/MainNavigator';
import { getEmployeeByEmployeeId, getEmployeeProjects } from '../utils/supabaseClient';
import { useAuth } from '../context/AuthContext';

type ProjectSelectionScreenNavigationProp = StackNavigationProp<RootStackParamList, 'ProjectSelection'>;
type ProjectSelectionScreenRouteProp = RouteProp<RootStackParamList, 'ProjectSelection'>;

interface Project {
  id: string;
  name: string;
  description?: string;
  created_at: string;
  activity_count: number;
  last_activity?: string;
  is_active?: boolean; // Add this field to track current project
}

interface Props {
  navigation: ProjectSelectionScreenNavigationProp;
  route: ProjectSelectionScreenRouteProp;
}

const ProjectSelectionScreen: React.FC<Props> = ({ navigation, route }) => {
  const { employeeId } = route.params;
  const { employee } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Load projects when component mounts
  useEffect(() => {
    loadProjects();
  }, [employeeId]);

  // Refresh projects every time the screen comes into focus
  useFocusEffect(
    React.useCallback(() => {
      console.log('🔄 ProjectSelectionScreen focused - refreshing projects');
      loadProjects();
    }, [employeeId])
  );

  const loadProjects = async () => {
    if (!employeeId || !employee?.organization_id) return;
    
    try {
      setLoading(true);
      
      // First get the employee data to get the UUID
      const employeeData = await getEmployeeByEmployeeId(employeeId, employee.organization_id);
      
      if (!employeeData) {
        console.error('Employee not found:', employeeId);
        return;
      }
      
      // Get employee-specific projects (only projects they have worked on)
      const projectsData = await getEmployeeProjects(employeeData.id, employee.organization_id);
      
      // Convert to project objects with activity count (for now, set to 0)
      const projectList: Project[] = projectsData.map(project => ({
        id: project.id,
        name: project.name,
        description: project.description || `Project: ${project.name}`,
        created_at: project.created_at,
        activity_count: 0, // TODO: Calculate actual activity count
        last_activity: project.updated_at,
        is_active: project.is_active // Include the active status
      }));

      setProjects(projectList);
    } catch (error) {
      console.error('Error loading projects:', error);
      Alert.alert('Error', 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await loadProjects();
    setRefreshing(false);
  };

  const handleProjectSelect = (project: Project) => {
    setSelectedProject(project.id);
    
    // Navigate to EmployeeDetail with project filter
    navigation.navigate('EmployeeDetail', {
      employeeId: employeeId,
      projectFilter: project.id
    });
  };

  const handleViewAllData = () => {
    // Navigate to EmployeeDetail without project filter
    navigation.navigate('EmployeeDetail', {
      employeeId: employeeId,
      projectFilter: undefined
    });
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#1e3a8a" />
        <Text style={styles.loadingText}>Loading projects...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Select Project</Text>
        <Text style={styles.subtitle}>
          Choose a project to view employee data, or view all data
        </Text>
      </View>

      <ScrollView
        style={styles.scrollContainer}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        {/* View All Data Option */}
        <TouchableOpacity
          style={[styles.projectCard, styles.allDataCard]}
          onPress={handleViewAllData}
        >
          <View style={styles.projectHeader}>
            <Text style={styles.projectName}>📊 All Data</Text>
            <Text style={styles.projectCount}>View all activity</Text>
          </View>
          <Text style={styles.projectDescription}>
            View all employee activity across all projects
          </Text>
        </TouchableOpacity>

        {/* Project List */}
        <Text style={styles.sectionTitle}>Projects ({projects.length})</Text>
        
        {projects.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>No projects found</Text>
            <Text style={styles.emptySubtext}>
              Employee hasn't worked on any projects yet
            </Text>
          </View>
        ) : (
          projects.map((project) => (
            <TouchableOpacity
              key={project.id}
              style={[
                styles.projectCard, 
                selectedProject === project.id && styles.selectedCard,
                project.is_active && styles.activeProjectCard
              ]}
              onPress={() => handleProjectSelect(project)}
            >
              <View style={styles.projectHeader}>
                <View style={styles.projectTitleContainer}>
                  <Text style={styles.projectName}>📁 {project.name}</Text>
                  {project.is_active && (
                    <View style={styles.activeIndicator}>
                      <Text style={styles.activeText}>🟢 Active</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.projectCount}>
                  {project.activity_count} activities
                </Text>
              </View>
              
              {project.last_activity && (
                <Text style={styles.lastActivity}>
                  Last activity: {new Date(project.last_activity).toLocaleDateString()}
                </Text>
              )}
              
              <Text style={styles.projectDescription}>
                {project.description}
              </Text>
            </TouchableOpacity>
          ))
        )}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
  },
  scrollContainer: {
    padding: 20,
  },
  projectCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 20,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  allDataCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 20,
    marginBottom: 20,
  },
  projectHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  projectTitleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  projectName: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  projectCount: {
    fontSize: 16,
    color: '#666',
  },
  projectDescription: {
    fontSize: 16,
    color: '#666',
  },
  lastActivity: {
    fontSize: 14,
    color: '#999',
    marginBottom: 8,
  },
  selectedCard: {
    backgroundColor: '#e0e0e0',
  },
  activeProjectCard: {
    borderWidth: 2,
    borderColor: '#4CAF50', // Green border for active projects
    backgroundColor: '#f8fff8', // Light green background
  },
  activeIndicator: {
    backgroundColor: '#4CAF50',
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginLeft: 10,
  },
  activeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  emptySubtext: {
    fontSize: 16,
    color: '#666',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    fontSize: 16,
    fontWeight: 'bold',
    marginTop: 20,
  },
});

export default ProjectSelectionScreen; 