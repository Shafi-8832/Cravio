import { useParams } from 'react-router-dom'
import AuthForm from '../components/AuthForm'
import RoleChooser from '../components/RoleChooser'
import { roleFromSlug } from '../utils/roles'

// Same fork as login. The chosen role is fixed by the URL, so the signup
// body always carries a role the visitor actually picked.
export default function SignupPage() {
  const role = roleFromSlug(useParams().role)
  return role ? <AuthForm role={role} signup /> : <RoleChooser signup />
}
