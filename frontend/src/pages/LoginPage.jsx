import { useParams } from 'react-router-dom'
import AuthForm from '../components/AuthForm'
import RoleChooser from '../components/RoleChooser'
import { loginRoleFromSlug, STAFF_LOGIN } from '../utils/roles'

// /login shows the account-type fork; /login/customer, /login/rider and
// /login/owner show that role's own screen, and /login/staff is the
// cardless screen admins use — /admin/login is the same screen under the
// address staff actually type. An unknown slug falls back to the fork
// rather than 404-ing someone out of the app.
export default function LoginPage({ staff = false }) {
  const slugRole = loginRoleFromSlug(useParams().role)
  const role = staff ? STAFF_LOGIN : slugRole
  return role ? <AuthForm role={role} /> : <RoleChooser />
}
