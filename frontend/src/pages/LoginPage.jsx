import { useParams } from 'react-router-dom'
import AuthForm from '../components/AuthForm'
import RoleChooser from '../components/RoleChooser'
import { loginRoleFromSlug } from '../utils/roles'

// /login shows the account-type fork; /login/customer, /login/rider and
// /login/owner show that role's own screen, and /login/staff is the
// cardless screen admins use. An unknown slug falls back to the fork
// rather than 404-ing someone out of the app.
export default function LoginPage() {
  const role = loginRoleFromSlug(useParams().role)
  return role ? <AuthForm role={role} /> : <RoleChooser />
}
