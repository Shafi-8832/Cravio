import { useAuth } from '../context/AuthContext'

const HomePage = () => {
  const { user } = useAuth()

  return (
    <div className="max-w-4xl mx-auto px-4 py-12 text-center">
      <h1 className="text-4xl font-bold text-gray-800 mb-4">
        Welcome to Cravio 🍔
      </h1>
      <p className="text-gray-500 text-lg">
        Logged in as <span className="font-semibold text-green-700">{user?.name}</span>
        {' '}({user?.role?.replace('_', ' ')})
      </p>
      <p className="text-gray-400 mt-2">
        Restaurant listings coming soon...
      </p>
    </div>
  )
}

export default HomePage