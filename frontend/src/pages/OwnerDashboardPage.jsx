import { useState, useEffect, useCallback } from 'react'
import LoadingSpinner from '../components/LoadingSpinner'
import BusinessSummary from '../components/BusinessSummary'
import RestaurantSettings from '../components/RestaurantSettings'
import OwnerItemEditor from '../components/OwnerItemEditor'
import OrderReceipt from '../components/OrderReceipt'
import { DIVISIONS } from '../utils/format'
import {
  getMyRestaurants,
  createRestaurant,
  addBranch,
  toggleBranch,
  createCategory,
  createMenuItem,
  toggleMenuItem,
  deleteMenuItem,
  getMenu,
  getRestaurantOrders,
  updateOrderStatus
} from '../services/ownerApi'

const ORDER_STATUS_COLORS = {
  pending: 'bg-yellow-100 text-yellow-700',
  confirmed: 'bg-blue-100 text-blue-700',
  preparing: 'bg-orange-100 text-orange-700',
  out_for_delivery: 'bg-purple-100 text-purple-700',
  delivered: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-600'
}

const OwnerDashboardPage = () => {
  const [tab, setTab] = useState('menu')
  const [editingItem, setEditingItem] = useState(null)
  const [expandedOrder, setExpandedOrder] = useState(null)

  const [restaurants, setRestaurants] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [newRestaurantName, setNewRestaurantName] = useState('')
  const [creatingRestaurant, setCreatingRestaurant] = useState(false)

  const [branchForm, setBranchForm] = useState({ address: '', area: '', city: '', phone: '', division: 'Dhaka', delivery_fee: 49, min_order_amount: 0, eta_min: 25, eta_max: 45 })

  const [menu, setMenu] = useState([])
  const [menuLoading, setMenuLoading] = useState(false)
  const [categoryName, setCategoryName] = useState('')
  const [itemForm, setItemForm] = useState({
    category_id: '',
    name: '',
    description: '',
    price: '', image_url: '',
    is_veg: false
  })

  const [orders, setOrders] = useState([])
  const [orderStatusFilter, setOrderStatusFilter] = useState('')
  const [ordersLoading, setOrdersLoading] = useState(false)

  const selectedRestaurant = restaurants.find(r => r.id === selectedId) || null

  const flashNotice = (message) => {
    setNotice(message)
    setTimeout(() => setNotice(''), 3000)
  }

  const loadRestaurants = useCallback(async () => {
    setLoading(true)
    setError('')

    try {
      const res = await getMyRestaurants()
      setRestaurants(res.data.restaurants)

      if (res.data.restaurants.length > 0) {
        setSelectedId(prev => prev ?? res.data.restaurants[0].id)
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load your restaurants.')
    } finally {
      setLoading(false)
    }
  }, [])

  // Fetch the remote dashboard on mount.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadRestaurants() }, [loadRestaurants])

  const loadMenu = useCallback(async (restaurantId) => {
    if (!restaurantId) return

    setMenuLoading(true)

    try {
      const res = await getMenu(restaurantId)
      setMenu(res.data.categories)
    } catch (err) {
      console.error(err)
    } finally {
      setMenuLoading(false)
    }
  }, [])

  useEffect(() => {
    // Fetch categories when the selected restaurant changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (selectedId) loadMenu(selectedId)
  }, [selectedId, loadMenu])

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true)

    try {
      const res = await getRestaurantOrders({ status: orderStatusFilter || undefined })
      setOrders(res.data.orders)
    } catch (err) {
      console.error(err)
    } finally {
      setOrdersLoading(false)
    }
  }, [orderStatusFilter])

  useEffect(() => {
    // Fetch the selected remote order filter.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (tab === 'orders') loadOrders()
  }, [tab, loadOrders])

  const handleCreateRestaurant = async (e) => {
    e.preventDefault()
    setError('')

    if (!newRestaurantName.trim()) return

    setCreatingRestaurant(true)

    try {
      await createRestaurant(newRestaurantName.trim())
      setNewRestaurantName('')
      await loadRestaurants()
      flashNotice('Restaurant created.')
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create restaurant.')
    } finally {
      setCreatingRestaurant(false)
    }
  }

  const handleAddBranch = async (e) => {
    e.preventDefault()
    setError('')

    if (!selectedId) return

    try {
      await addBranch(selectedId, branchForm)
      setBranchForm({ address: '', area: '', city: '', phone: '', division: 'Dhaka', delivery_fee: 49, min_order_amount: 0, eta_min: 25, eta_max: 45 })
      await loadRestaurants()
      flashNotice('Branch added.')
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add branch.')
    }
  }

  const handleToggleBranch = async (branchId) => {
    setError('')

    try {
      await toggleBranch(branchId)
      await loadRestaurants()
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to toggle branch.')
    }
  }

  const handleCreateCategory = async (e) => {
    e.preventDefault()
    setError('')

    if (!categoryName.trim() || !selectedId) return

    try {
      await createCategory(selectedId, categoryName.trim())
      setCategoryName('')
      await loadMenu(selectedId)
      flashNotice('Category added.')
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add category.')
    }
  }

  const handleCreateItem = async (e) => {
    e.preventDefault()
    setError('')

    if (!itemForm.category_id || !itemForm.name.trim() || itemForm.price === '') return

    try {
      await createMenuItem(itemForm.category_id, {
        name: itemForm.name.trim(),
        description: itemForm.description.trim() || undefined,
        price: Number(itemForm.price),
        is_veg: itemForm.is_veg,
        image_url: itemForm.image_url || undefined
      })
      setItemForm({ category_id: '', name: '', description: '', price: '', image_url: '', is_veg: false })
      await loadMenu(selectedId)
      flashNotice('Menu item added.')
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add menu item.')
    }
  }

  const handleToggleItem = async (itemId) => {
    setError('')

    try {
      await toggleMenuItem(itemId)
      await loadMenu(selectedId)
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to toggle item.')
    }
  }

  const handleDeleteItem = async (itemId) => {
    setError('')

    if (!window.confirm('Delete this menu item?')) return

    try {
      await deleteMenuItem(itemId)
      await loadMenu(selectedId)
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete item.')
    }
  }

  const handleUpdateOrderStatus = async (orderId, status) => {
    setError('')

    try {
      await updateOrderStatus(orderId, status)
      await loadOrders()
      flashNotice('Order updated.')
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update order.')
    }
  }

  if (loading) return <LoadingSpinner message="Loading your dashboard..." />

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="dashboard-heading"><p className="eyebrow mb-2">Made with care, served with pride</p><h1 className="section-heading">Your restaurant studio 👨‍🍳</h1></div>
      <p className="text-gray-500 mb-6">Manage your restaurants, menus, and incoming orders.</p>
      <BusinessSummary />
      {selectedRestaurant && <RestaurantSettings key={selectedRestaurant.id} restaurant={selectedRestaurant} onSaved={loadRestaurants} />}

      {error && (
        <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg mb-4 text-sm">
          {error}
        </div>
      )}
      {notice && (
        <div className="bg-green-50 text-green-700 px-4 py-3 rounded-lg mb-4 text-sm">
          {notice}
        </div>
      )}

      <div className="flex gap-2 mb-6 border-b border-gray-200">
        <button className="ml-auto btn-secondary" onClick={() => { loadRestaurants(); if (tab === 'orders') loadOrders() }}>Refresh</button>
        {['menu', 'orders'].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-semibold capitalize border-b-2 -mb-px transition-colors ${
              tab === t
                ? 'border-green-700 text-green-700'
                : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}
          >
            {t === 'menu' ? 'Restaurants & Menu' : 'Orders'}
          </button>
        ))}
      </div>

      {tab === 'menu' && (
        <div>
          {restaurants.length === 0 ? (
            <form
              onSubmit={handleCreateRestaurant}
              className="bg-white rounded-xl border border-gray-100 p-5 max-w-md"
            >
              <h2 className="font-semibold text-gray-700 mb-3">Create your first restaurant</h2>
              <input
                value={newRestaurantName}
                onChange={e => setNewRestaurantName(e.target.value)}
                placeholder="Restaurant name"
                required
                className="w-full border border-gray-300 rounded-lg px-4 py-2 mb-3
                           focus:outline-none focus:ring-2 focus:ring-green-500"
              />
              <button
                type="submit"
                disabled={creatingRestaurant}
                className="bg-green-700 text-white px-4 py-2 rounded-lg font-semibold
                           hover:bg-green-800 disabled:opacity-50"
              >
                {creatingRestaurant ? 'Creating...' : 'Create restaurant'}
              </button>
            </form>
          ) : (
            <>
              {restaurants.length > 1 && (
                <select
                  value={selectedId ?? ''}
                  onChange={e => setSelectedId(Number(e.target.value))}
                  className="border border-gray-200 rounded-xl px-4 py-2 bg-white mb-6
                             focus:outline-none focus:ring-2 focus:ring-green-500"
                >
                  {restaurants.map(r => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              )}

              {selectedRestaurant && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

                  {/* Branches */}
                  <div className="bg-white rounded-xl border border-gray-100 p-5">
                    <h2 className="font-semibold text-gray-700 mb-3">
                      Branches — {selectedRestaurant.name}
                    </h2>

                    <div className="space-y-2 mb-4">
                      {selectedRestaurant.branches.length === 0 && (
                        <p className="text-sm text-gray-400">No branches yet.</p>
                      )}

                      {selectedRestaurant.branches.map(b => (
                        <div
                          key={b.id}
                          className="flex items-center justify-between border border-gray-100
                                     rounded-lg px-3 py-2"
                        >
                          <div>
                            <p className="text-sm font-medium text-gray-700">
                              {b.area}, {b.city}
                            </p>
                            <p className="text-xs text-gray-400">{b.address}</p>
                          </div>
                          <button
                            onClick={() => handleToggleBranch(b.id)}
                            className={`text-xs px-3 py-1 rounded-full font-medium ${
                              b.is_open
                                ? 'bg-green-100 text-green-700'
                                : 'bg-red-100 text-red-600'
                            }`}
                          >
                            {b.is_open ? 'Open' : 'Closed'}
                          </button>
                        </div>
                      ))}
                    </div>

                    <form onSubmit={handleAddBranch} className="space-y-2">
                      <input
                        required
                        placeholder="Address"
                        value={branchForm.address}
                        onChange={e => setBranchForm({ ...branchForm, address: e.target.value })}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      />
                      <div className="flex gap-2">
                        <input
                          required
                          placeholder="Area"
                          value={branchForm.area}
                          onChange={e => setBranchForm({ ...branchForm, area: e.target.value })}
                          className="w-1/2 border border-gray-300 rounded-lg px-3 py-2 text-sm"
                        />
                        <input
                          required
                          placeholder="City"
                          value={branchForm.city}
                          onChange={e => setBranchForm({ ...branchForm, city: e.target.value })}
                          className="w-1/2 border border-gray-300 rounded-lg px-3 py-2 text-sm"
                        />
                      </div>
                      <input
                        placeholder="Phone (optional)"
                        value={branchForm.phone}
                        onChange={e => setBranchForm({ ...branchForm, phone: e.target.value })}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      />
                      <label className="field-label">Division<select className="field" value={branchForm.division} onChange={e => setBranchForm({ ...branchForm, division: e.target.value })}>{DIVISIONS.map(value => <option key={value}>{value}</option>)}</select></label>
                      <div className="grid grid-cols-2 gap-2">{[['delivery_fee', 'Delivery fee'], ['min_order_amount', 'Minimum order'], ['eta_min', 'ETA minimum'], ['eta_max', 'ETA maximum']].map(([key, label]) => <label className="text-sm" key={key}>{label}<input type="number" min={key.startsWith('eta') ? 1 : 0} required className="field mt-1" value={branchForm[key]} onChange={e => setBranchForm({ ...branchForm, [key]: Number(e.target.value) })} /></label>)}</div>
                      <button
                        type="submit"
                        className="bg-green-700 text-white px-4 py-2 rounded-lg text-sm
                                   font-semibold hover:bg-green-800"
                      >
                        Add branch
                      </button>
                    </form>
                  </div>

                  {/* Menu */}
                  <div className="bg-white rounded-xl border border-gray-100 p-5">
                    <h2 className="font-semibold text-gray-700 mb-3">Menu</h2>

                    <form onSubmit={handleCreateCategory} className="flex gap-2 mb-4">
                      <input
                        placeholder="New category name"
                        value={categoryName}
                        onChange={e => setCategoryName(e.target.value)}
                        className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      />
                      <button
                        type="submit"
                        className="bg-green-700 text-white px-3 py-2 rounded-lg text-sm
                                   font-semibold hover:bg-green-800"
                      >
                        Add
                      </button>
                    </form>

                    {menuLoading ? (
                      <p className="text-sm text-gray-400">Loading menu...</p>
                    ) : menu.length === 0 ? (
                      <p className="text-sm text-gray-400 mb-4">No categories yet.</p>
                    ) : (
                      <div className="space-y-4 mb-4 max-h-80 overflow-y-auto">
                        {menu.map(cat => (
                          <div key={cat.id}>
                            <p className="text-sm font-semibold text-gray-600 mb-1">{cat.name}</p>
                            {cat.items.length === 0 ? (
                              <p className="text-xs text-gray-400 ml-2">No items.</p>
                            ) : (
                              cat.items.map(item => (
                                <div
                                  key={item.id}
                                  className="flex items-center justify-between ml-2 py-1 text-sm"
                                >
                                  <span className="text-gray-700">
                                    {item.name} — ৳{Number(item.price).toFixed(2)}
                                  </span>
                                  <div className="flex items-center gap-2">
                                    <button className="text-xs text-orange-700" onClick={() => setEditingItem(item)}>Edit</button>
                                    <button
                                      onClick={() => handleToggleItem(item.id)}
                                      className={`text-xs px-2 py-1 rounded-full ${
                                        item.is_available
                                          ? 'bg-green-100 text-green-700'
                                          : 'bg-gray-100 text-gray-500'
                                      }`}
                                    >
                                      {item.is_available ? 'Available' : 'Hidden'}
                                    </button>
                                    <button
                                      onClick={() => handleDeleteItem(item.id)}
                                      className="text-gray-300 hover:text-red-500"
                                    >
                                      ✕
                                    </button>
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    <form onSubmit={handleCreateItem} className="space-y-2 border-t border-gray-100 pt-4">
                      <label className="field-label">Menu photo URL<input className="field mt-1" maxLength={255} placeholder="https://… or /media/filename.jpg" value={itemForm.image_url} onChange={e => setItemForm({ ...itemForm, image_url: e.target.value })} /></label>
                      <select
                        required
                        value={itemForm.category_id}
                        onChange={e => setItemForm({ ...itemForm, category_id: e.target.value })}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
                      >
                        <option value="">Select category...</option>
                        {menu.map(cat => (
                          <option key={cat.id} value={cat.id}>{cat.name}</option>
                        ))}
                      </select>
                      <input
                        required
                        placeholder="Item name"
                        value={itemForm.name}
                        onChange={e => setItemForm({ ...itemForm, name: e.target.value })}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      />
                      <input
                        placeholder="Description (optional)"
                        value={itemForm.description}
                        onChange={e => setItemForm({ ...itemForm, description: e.target.value })}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      />
                      <div className="flex items-center gap-3">
                        <input
                          required
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="Price"
                          value={itemForm.price}
                          onChange={e => setItemForm({ ...itemForm, price: e.target.value })}
                          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
                        />
                        <label className="flex items-center gap-1 text-sm text-gray-600">
                          <input
                            type="checkbox"
                            checked={itemForm.is_veg}
                            onChange={e => setItemForm({ ...itemForm, is_veg: e.target.checked })}
                          />
                          Veg
                        </label>
                      </div>
                      <button
                        type="submit"
                        className="bg-green-700 text-white px-4 py-2 rounded-lg text-sm
                                   font-semibold hover:bg-green-800"
                      >
                        Add item
                      </button>
                    </form>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'orders' && (
        <div>
          <select
            value={orderStatusFilter}
            onChange={e => setOrderStatusFilter(e.target.value)}
            className="border border-gray-200 rounded-xl px-4 py-2 bg-white mb-6
                       focus:outline-none focus:ring-2 focus:ring-green-500"
          >
            <option value="">All statuses</option>
            {Object.keys(ORDER_STATUS_COLORS).map(s => (
              <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
            ))}
          </select>

          {ordersLoading ? (
            <p className="text-gray-400">Loading orders...</p>
          ) : orders.length === 0 ? (
            <p className="text-gray-400">No orders found.</p>
          ) : (
            <div className="space-y-3">
              {orders.map(order => (
                <div
                  key={order.id}
                  className="bg-white rounded-xl border border-gray-100 p-4
                             flex items-center justify-between flex-wrap gap-3"
                >
                  <div>
                    <p className="font-semibold text-gray-800">
                      Order #{order.id} — {order.customer_name}
                    </p>
                    <p className="text-sm text-gray-400">
                      {order.restaurant_name} · {order.branch_area}, {order.branch_city}
                      {' · '}৳{Number(order.total_amount).toFixed(2)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button className="btn-secondary !py-1" onClick={() => setExpandedOrder(expandedOrder === order.id ? null : order.id)}>Receipt & payment</button>
                    <span className={`text-xs px-2 py-1 rounded-full font-medium capitalize ${
                      ORDER_STATUS_COLORS[order.status] || 'bg-gray-100 text-gray-600'
                    }`}>
                      {order.status.replace(/_/g, ' ')}
                    </span>

                    {order.status === 'pending' && (
                      <>
                        <button
                          onClick={() => handleUpdateOrderStatus(order.id, 'confirmed')}
                          className="text-xs bg-green-700 text-white px-3 py-1 rounded-full
                                     hover:bg-green-800"
                        >
                          Accept
                        </button>
                        <button
                          onClick={() => handleUpdateOrderStatus(order.id, 'cancelled')}
                          className="text-xs bg-red-100 text-red-600 px-3 py-1 rounded-full
                                     hover:bg-red-200"
                        >
                          Reject
                        </button>
                      </>
                    )}

                    {order.status === 'confirmed' && (
                      <>
                        <button
                          onClick={() => handleUpdateOrderStatus(order.id, 'preparing')}
                          className="text-xs bg-green-700 text-white px-3 py-1 rounded-full
                                     hover:bg-green-800"
                        >
                          Start preparing
                        </button>
                        <button
                          onClick={() => handleUpdateOrderStatus(order.id, 'cancelled')}
                          className="text-xs bg-red-100 text-red-600 px-3 py-1 rounded-full
                                     hover:bg-red-200"
                        >
                          Cancel
                        </button>
                      </>
                    )}
                  </div>
                  {expandedOrder === order.id && <div className="w-full"><OrderReceipt id={order.id} onChanged={loadOrders} /></div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {editingItem && <OwnerItemEditor item={editingItem} restaurantId={selectedId} onClose={() => setEditingItem(null)} onSaved={() => loadMenu(selectedId)} />}
    </div>
  )
}

export default OwnerDashboardPage
